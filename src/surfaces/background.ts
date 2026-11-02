import { InvocationError, InvocationErrorCode, Queue } from '@forge/events';
import { confluence } from '../adapters/confluence';
import { jira } from '../adapters/jira';
import { sqlRepo, type Repo } from '../adapters/repo';
import { loadDemoData, resetDemo, SeedError, simulateBusyMonth, type SeedDeps } from '../adapters/seed';
import { ensureSchema, requestMigration, runMigrations } from '../adapters/sql';
import { BATCH_SIZE, chunk, EvaluationRateLimitedError, evaluateMany, summarise, type EvalDeps } from '../core/evaluator';
import { extractPage, type ExtractDeps } from '../core/extractPipeline';
import { SchemaSettingUpError } from '../core/schema';
import { SettingsError } from '../core/settings';
import { runRadarScan, type RadarScanDeps, type RadarScanResult } from '../core/radar';
import { openRevisit } from '../core/revisit';
import { EVALUABLE_STATUSES } from '../core/state';
import { checkin, contentChange, date, jqlThreshold } from '../core/triggers';
import type { ContentChangeSpec } from '../core/types';
import { chatTool, isLlmRateLimited } from '../llm';
import { repairAssumption, runExtraction } from '../llm/extract';
import { classifyPair } from '../llm/radar';
import { DEMO_JOB_LOCK_SECONDS, runDemoJob, type DemoJob, type DemoProgress } from './demoJob';

export const EXTRACT_QUEUE = 'extract';
export const EVALUATE_QUEUE = 'evaluate';
export const RADAR_QUEUE = 'radar-scan';
export const DEMO_QUEUE = 'demo-seed';

const extractQueue = new Queue({ key: EXTRACT_QUEUE });
const evaluateQueue = new Queue({ key: EVALUATE_QUEUE });
const radarQueue = new Queue({ key: RADAR_QUEUE });
const demoQueue = new Queue({ key: DEMO_QUEUE });

/**
 * App lock held by one Radar scan at a time. It outlives the consumer timeout (900 s in manifest.yml), so a second
 * scan cannot start while a slow one is still running; a crashed scan frees it when it expires.
 */
export const RADAR_LOCK = 'radar-scan';
export const RADAR_LOCK_SECONDS = 20 * 60;
/** Delay after an extraction, so a burst of extractions (e.g. a demo load) ends in one scan. */
const RADAR_AFTER_EXTRACT_SECONDS = 30;
/** App value with the outcome of the last scan (shown on the Radar tab). */
export const RADAR_LAST_SCAN_KEY = 'radar-last-scan';

/** Max tripwires the daily run schedules; Queue.push accepts at most 50 events per call. */
const MAX_SCHEDULED = 1000;
const PUSH_LIMIT = 50;
const RATE_LIMIT_DELAY_SECONDS = 60;
/** A batch is re-queued after a Jira 429 at most this many times; the next daily run picks up the rest. */
export const MAX_EVALUATE_ATTEMPTS = 3;
const EXTRACT_LOCKED_RETRY_SECONDS = 30;

const now = () => new Date();

/** Evaluator wiring shared by the queue consumer and the setup page's "Run evaluation now". */
export const evalDeps: EvalDeps = {
  repo: sqlRepo,
  readers: {
    jql_threshold: jqlThreshold.evaluate,
    date: date.evaluate,
    checkin: checkin.evaluate,
    content_change: contentChange.evaluate,
  },
  openRevisit: async (tripwireId) => {
    const result = await openRevisit(tripwireId, {
      repo: sqlRepo,
      jira,
      now,
      pageUrl: async (pageId) => (await confluence.getPage(pageId)).webUrl,
    });
    console.info('tripwire revisit', { tripwireId, ...result });
    return result;
  },
  now,
};

interface PageEvent {
  eventType?: string;
  content?: { id?: string; type?: string };
}

/**
 * Ids of the confirmed content_change tripwires watching `pageId` (a content_change tripwire can only watch its
 * own decision page, so the page's decision is enough).
 */
export async function contentChangeTripwireIds(pageId: string, repo: Pick<Repo, 'getDecisionByPage' | 'listTripwires'>): Promise<string[]> {
  const decision = await repo.getDecisionByPage(pageId);
  if (!decision) return [];
  return (await repo.listTripwires(decision.id))
    .filter((t) => t.kind === 'content_change' && EVALUABLE_STATUSES.includes(t.status) && (t.spec as ContentChangeSpec).pageId === pageId)
    .map((t) => t.id);
}

/**
 * Confluence page created/updated → queue an evaluation of the page's content_change tripwires right away, and
 * enqueue extraction for labelled pages in watched spaces (LLM work runs only in the consumer).
 */
export async function onPageEvent(event: PageEvent): Promise<void> {
  const pageId = event.content?.id;
  if (!pageId) return;
  if (!(await schemaReady('onPageEvent'))) return;
  try {
    const ids = await contentChangeTripwireIds(pageId, sqlRepo);
    if (ids.length > 0) {
      await pushBatches(ids);
      console.info('tripwire onPageEvent: content_change evaluation queued', { pageId, tripwires: ids.length });
    }
  } catch (err) {
    // The daily run still evaluates these; do not lose the extraction below.
    console.warn('tripwire onPageEvent: content_change evaluation not queued', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  const settings = await sqlRepo.getSettings();
  const labels = await confluence.getPageLabels(pageId);
  if (!labels.includes(settings.decisionLabel)) return;
  if (settings.watchedSpaceKeys.length > 0) {
    const page = await confluence.getPage(pageId);
    const spaceKey = await confluence.getSpaceKey(page.spaceId);
    if (!settings.watchedSpaceKeys.includes(spaceKey)) return;
  }
  await enqueueExtraction(pageId, false);
}

/** Queues evaluation of these tripwires in batches of `BATCH_SIZE` (used by the demo's "Simulate a busy month"). */
export async function enqueueEvaluation(ids: readonly string[]): Promise<void> {
  if (ids.length > 0) await pushBatches(ids);
}

/** Queues extraction for one page; `requestedBy` (the Scan button user) becomes the decision owner. */
export async function enqueueExtraction(pageId: string, force: boolean, requestedBy?: string): Promise<string> {
  const { jobId } = await extractQueue.push({ body: { pageId, force, ...(requestedBy ? { requestedBy } : {}) } });
  return jobId;
}

async function pushBatches(ids: readonly string[], delayInSeconds?: number, attempt = 1): Promise<number> {
  const events = chunk(ids, BATCH_SIZE).map((tripwireIds) => ({
    body: { tripwireIds, attempt },
    ...(delayInSeconds ? { delayInSeconds } : {}),
  }));
  for (const group of chunk(events, PUSH_LIMIT)) await evaluateQueue.push(group);
  return events.length;
}

/** Daily: apply pending migrations, queue a Radar scan, then fan out evaluation batches of `BATCH_SIZE` tripwires. */
export async function scheduleEvaluation(): Promise<void> {
  if (!(await schemaReady('scheduleEvaluation'))) return;
  await scheduleRadarScan();
  const ids: string[] = [];
  for (let offset = 0; offset < MAX_SCHEDULED; offset += 500) {
    const page = await sqlRepo.listTripwireIdsForEvaluation(EVALUABLE_STATUSES, 500, offset);
    ids.push(...page);
    if (page.length < 500) break;
  }
  if (ids.length === 0) {
    console.info('tripwire scheduleEvaluation: nothing to evaluate');
    return;
  }
  const batches = await pushBatches(ids);
  console.info('tripwire scheduleEvaluation', { tripwires: ids.length, batches });
}

/** Daily: one Radar scan (new or changed decision pairs only). */
export async function scheduleRadarScan(): Promise<void> {
  try {
    await enqueueRadarScan('daily');
  } catch (err) {
    console.warn('tripwire radar: daily scan not queued', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Queues one Radar scan; the consumer makes at most `MAX_CLASSIFY_PER_SCAN` LLM calls. */
export async function enqueueRadarScan(reason: 'daily' | 'extract' | 'manual', delayInSeconds?: number): Promise<string> {
  const { jobId } = await radarQueue.push({ body: { reason }, ...(delayInSeconds ? { delayInSeconds } : {}) });
  return jobId;
}

export interface RadarConsumerDeps {
  repo: Repo;
  classify: RadarScanDeps['classify'];
  now: () => Date;
}

/**
 * Runs one scan under the `radar-scan` app lock. Returns `retry` when another scan holds the lock or the LLM is
 * rate limited (the queue redelivers the event later).
 */
export async function radarScanWith(deps: RadarConsumerDeps): Promise<{ status: 'done' | 'locked' | 'rate_limited'; result?: RadarScanResult }> {
  const { repo } = deps;
  if (!(await repo.acquireAppLock(RADAR_LOCK, deps.now().toISOString(), RADAR_LOCK_SECONDS))) return { status: 'locked' };
  try {
    // Graph caches from before aggregates-only held contributor account ids; clear them (a no-op once done).
    const purged = await repo.purgeLegacyRadarGraphs().catch((err: unknown) => {
      console.warn('tripwire radar: legacy graph purge failed', { error: err instanceof Error ? err.message : String(err) });
      return 0;
    });
    if (purged > 0) console.info('tripwire radar: legacy graph caches cleared', { purged });
    const result = await runRadarScan({ repo, classify: deps.classify, isRateLimited: isLlmRateLimited });
    await repo.setAppValue(RADAR_LAST_SCAN_KEY, { at: deps.now().toISOString(), ...result });
    console.info('tripwire radar scan', result);
    return { status: result.rateLimited ? 'rate_limited' : 'done', result };
  } finally {
    await repo.releaseAppLock(RADAR_LOCK).catch((err: unknown) => {
      console.warn('tripwire radar: lock release failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Consumer for the `radar-scan` queue. */
export async function radarScan(): Promise<InvocationError | void> {
  if (!(await schemaReady('radarScan'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  const outcome = await radarScanWith({ repo: sqlRepo, classify: (a, b) => classifyPair(a, b), now });
  if (outcome.status === 'locked') return retryLater(60, 'locked');
  if (outcome.status === 'rate_limited') return retryLater(RATE_LIMIT_DELAY_SECONDS);
}

/** Queue consumers whose schema is still being set up retry after this delay. */
const SCHEMA_RETRY_SECONDS = 60;
/** Time the `schema-migrate` consumer spends waiting out the DDL rate limit before re-queueing (timeout is 900 s). */
const MIGRATE_BUDGET_MS = 12 * 60 * 1000;

/** `ensureSchema` for background work: false while the schema is still being set up (a migration run is queued). */
async function schemaReady(where: string): Promise<boolean> {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    if (!(err instanceof SchemaSettingUpError)) throw err;
    console.info(`tripwire ${where}: database still being set up`, { applied: err.applied, total: err.total });
    return false;
  }
}

/** Lifecycle trigger (app installed / major upgrade): start the schema migration right away. */
export async function onAppLifecycle(event: { eventType?: string }): Promise<void> {
  const jobId = await requestMigration(event.eventType ?? 'lifecycle');
  console.info('tripwire migrations: queued', { eventType: event.eventType, jobId });
}

/**
 * Consumer for the `schema-migrate` queue: the only place that runs DDL. Waits out the Forge SQL DDL rate limit
 * (25 per minute; a new install has ~30 migrations) and re-queues itself if it runs out of time.
 */
export async function migrateSchema(): Promise<InvocationError | void> {
  const result = await runMigrations(MIGRATE_BUDGET_MS);
  console.info('tripwire migrations', result);
  if (result.status === 'pending') return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
}

interface QueueEvent {
  body?: Record<string, unknown>;
}

// --- Demo data (setup page buttons) -----------------------------------------------------------------

/** Demo seeding as the app (also used by tests through `demoSeedDeps`). */
export const seedDeps: SeedDeps = {
  jira,
  confluence,
  repo: sqlRepo,
  enqueueExtraction,
  enqueueEvaluation,
  evaluate: async (ids) => {
    try {
      return { results: await evaluateMany(ids, evalDeps), rateLimited: false };
    } catch (err) {
      if (!(err instanceof EvaluationRateLimitedError)) throw err;
      return { results: err.done, rateLimited: true };
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** The demo consumer stops starting new work after this long (its timeout is 900 s). */
export const DEMO_BUDGET_MS = 12 * 60 * 1000;
/** How long the consumer waits for Jira search to see the demo tickets. */
export const DEMO_INDEX_WAIT_MS = 3 * 60 * 1000;

/**
 * Seed wiring for one background job: long limits, progress reporting, and page access from the resolver's check
 * (a queue consumer has no user, so `canEditPage` cannot run here). Pages nobody checked throw, which the seed
 * functions already treat as "unknown".
 */
export function demoSeedDeps(base: SeedDeps, job: Pick<DemoJob, 'editablePageIds' | 'checkedPageIds'>, progress: DemoProgress): SeedDeps {
  const editable = new Set(job.editablePageIds);
  const checked = new Set(job.checkedPageIds);
  return {
    ...base,
    confluence: {
      ...base.confluence,
      canEditPage: async (pageId) => {
        if (editable.has(pageId)) return true;
        if (checked.has(pageId)) return false;
        throw new Error(`Page ${pageId} access was not checked before the demo job started`);
      },
    },
    limits: { budgetMs: DEMO_BUDGET_MS, indexWaitMs: DEMO_INDEX_WAIT_MS, lockSeconds: DEMO_JOB_LOCK_SECONDS },
    progress,
  };
}

/** Runs one demo job's work with `deps` (logged like the old inline resolvers). */
export async function runDemoWork(job: DemoJob, deps: SeedDeps): Promise<unknown> {
  switch (job.kind) {
    case 'load': {
      const result = await loadDemoData(job.accountId, deps);
      console.info('tripwire loadDemoData', { pageId: result.pageId, issueCount: result.issueCount, billingIssueCount: result.billingIssueCount, pages: result.pages.length, extractionsQueued: result.extractionsQueued, complete: result.complete, created: result.created });
      return result;
    }
    case 'simulate': {
      const result = await simulateBusyMonth(deps, job.accountId);
      console.info('tripwire simulateBusyMonth', { created: result.created, issueCount: result.issueCount, billingIssueCount: result.billingIssueCount, indexed: result.indexed, complete: result.complete, passes: result.passes, revisits: result.revisits.length, confirmed: result.confirmed, queued: result.queued });
      return result;
    }
    case 'reset': {
      const result = await resetDemo(job.accountId, deps);
      console.info('tripwire resetDemo', { ...result, revisitIssueKeys: result.revisitIssueKeys.length, warnings: result.warnings.length });
      return result;
    }
  }
}

/** Queues a demo job for the `demo-seed` consumer. */
export async function enqueueDemoJob(jobId: string): Promise<void> {
  await demoQueue.push({ body: { jobId } });
}

/** Consumer for the `demo-seed` queue: runs one "Load demo data" / "Simulate a busy month" / "Reset demo" job to the end. */
export async function demoJob(event: QueueEvent): Promise<InvocationError | void> {
  const jobId = event.body?.jobId;
  if (typeof jobId !== 'string' || jobId === '') throw new Error('demo event is missing jobId');
  if (!(await schemaReady('demoJob'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  await runDemoJob(jobId, {
    repo: sqlRepo,
    now: () => Date.now(),
    run: (job, progress) => runDemoWork(job, demoSeedDeps({ ...seedDeps, repo: sqlRepo }, job, progress)),
    userMessage: (err) => (err instanceof SeedError || err instanceof SettingsError ? err.message : undefined),
  });
}

/** Asks the queue to redeliver the event after `seconds` (used when Forge LLM is rate limited). */
export function retryLater(seconds: number, reason = 'rate_limited'): InvocationError {
  // retryData must be set: the Forge runtime measures its serialised size and fails with ERR_INVALID_ARG_TYPE when it is undefined.
  return new InvocationError({
    retryAfter: seconds,
    retryReason: InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED,
    retryData: { reason },
  });
}

/** Queues an LLM smoke test; the consumer logs `llm probe` with the tool arguments and token usage. */
export async function enqueueLlmProbe(): Promise<string> {
  const { jobId } = await extractQueue.push({ body: { probe: true } });
  return jobId;
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo back a boolean to confirm tool calling works.',
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};

const extractDeps: ExtractDeps = {
  repo: sqlRepo,
  confluence,
  jira,
  runExtraction,
  repairAssumption,
  now: () => new Date(),
};

/** Consumer for the `extract` queue: extracts a decision page; `probe` events test Forge LLM. */
export async function extractDecision(event: QueueEvent): Promise<InvocationError | void> {
  if (event.body?.probe === true) {
    try {
      const result = await chatTool<{ ok?: unknown }>([{ role: 'user', content: 'Call echo with ok=true' }], ECHO_TOOL);
      console.info('llm probe', result);
    } catch (err) {
      if (isLlmRateLimited(err)) return retryLater(60);
      console.error('llm probe failed', err);
    }
    return;
  }
  const pageId = event.body?.pageId;
  if (typeof pageId !== 'string') throw new Error('extract event is missing pageId');
  const force = event.body?.force === true;
  const requestedBy = typeof event.body?.requestedBy === 'string' ? event.body.requestedBy : undefined;
  if (!(await schemaReady('extractDecision'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  try {
    const result = await extractPage({ pageId, force, requestedBy }, extractDeps);
    console.info('tripwire extract', { pageId, force, ...result });
    if (result.status === 'done') {
      // A new or changed decision may contradict another one; failing to queue must not fail the extraction.
      await enqueueRadarScan('extract', RADAR_AFTER_EXTRACT_SECONDS).catch((err: unknown) => {
        console.warn('tripwire radar: scan after extraction not queued', { pageId, error: err instanceof Error ? err.message : String(err) });
      });
    }
    // Another extraction of this page is running; run again afterwards so this request is not lost.
    if (result.status === 'skipped' && result.reason === 'locked') return retryLater(EXTRACT_LOCKED_RETRY_SECONDS, 'locked');
  } catch (err) {
    if (isLlmRateLimited(err)) return retryLater(60);
    throw err;
  }
}

/** Consumer for the `evaluate` queue: evaluates up to `BATCH_SIZE` tripwires in order. */
export async function evaluateBatch(event: QueueEvent): Promise<InvocationError | void> {
  const ids = event.body?.tripwireIds;
  if (!Array.isArray(ids) || ids.length > BATCH_SIZE || !ids.every((id): id is string => typeof id === 'string' && id !== '')) {
    throw new Error(`evaluate event tripwireIds must be an array of at most ${BATCH_SIZE} ids`);
  }
  const rawAttempt = event.body?.attempt;
  const attempt = typeof rawAttempt === 'number' && Number.isInteger(rawAttempt) && rawAttempt > 0 ? rawAttempt : 1;
  if (!(await schemaReady('evaluateBatch'))) return retryLater(SCHEMA_RETRY_SECONDS, 'schema');
  try {
    const results = await evaluateMany(ids, evalDeps);
    console.info('tripwire evaluateBatch', summarise(results));
  } catch (err) {
    if (!(err instanceof EvaluationRateLimitedError)) throw err;
    if (attempt >= MAX_EVALUATE_ATTEMPTS) {
      console.error('tripwire evaluateBatch: Jira rate limited, giving up until the next daily run', {
        ...summarise(err.done),
        remaining: err.remaining.length,
        attempt,
      });
      return;
    }
    // Re-queue only what is left: retrying the whole event would record a second strike for tripwires already done.
    await pushBatches(err.remaining, RATE_LIMIT_DELAY_SECONDS, attempt + 1);
    console.warn('tripwire evaluateBatch: Jira rate limited, re-queued remaining', {
      ...summarise(err.done),
      remaining: err.remaining.length,
      attempt,
    });
  }
}
