import { InvocationError, InvocationErrorCode, Queue } from '@forge/events';
import { confluence } from '../adapters/confluence';
import { jira } from '../adapters/jira';
import { sqlRepo, type Repo } from '../adapters/repo';
import { ensureSchema } from '../adapters/sql';
import { BATCH_SIZE, chunk, EvaluationRateLimitedError, evaluateMany, summarise, type EvalDeps } from '../core/evaluator';
import { extractPage, type ExtractDeps } from '../core/extractPipeline';
import { openRevisit } from '../core/revisit';
import { EVALUABLE_STATUSES } from '../core/state';
import { checkin, contentChange, date, jqlThreshold } from '../core/triggers';
import type { ContentChangeSpec } from '../core/types';
import { chatTool, isLlmRateLimited } from '../llm';
import { repairAssumption, runExtraction } from '../llm/extract';

export const EXTRACT_QUEUE = 'extract';
export const EVALUATE_QUEUE = 'evaluate';

const extractQueue = new Queue({ key: EXTRACT_QUEUE });
const evaluateQueue = new Queue({ key: EVALUATE_QUEUE });

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
  await ensureSchema();
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

/** Daily: apply pending migrations, then fan out evaluation batches of `BATCH_SIZE` tripwires. */
export async function scheduleEvaluation(): Promise<void> {
  await ensureSchema();
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

interface QueueEvent {
  body?: Record<string, unknown>;
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
  await ensureSchema();
  try {
    const result = await extractPage({ pageId, force, requestedBy }, extractDeps);
    console.info('tripwire extract', { pageId, force, ...result });
    // Another extraction of this page is running; run again afterwards so this request is not lost.
    if (result.status === 'skipped' && result.reason === 'locked') return retryLater(EXTRACT_LOCKED_RETRY_SECONDS, 'locked');
  } catch (err) {
    if (isLlmRateLimited(err)) return retryLater(60);
    throw err;
  }
}

/** Consumer for the `evaluate` queue: evaluates up to `BATCH_SIZE` tripwires in order. */
export async function evaluateBatch(event: QueueEvent): Promise<void> {
  const ids = event.body?.tripwireIds;
  if (!Array.isArray(ids) || ids.length > BATCH_SIZE || !ids.every((id): id is string => typeof id === 'string' && id !== '')) {
    throw new Error(`evaluate event tripwireIds must be an array of at most ${BATCH_SIZE} ids`);
  }
  const rawAttempt = event.body?.attempt;
  const attempt = typeof rawAttempt === 'number' && Number.isInteger(rawAttempt) && rawAttempt > 0 ? rawAttempt : 1;
  await ensureSchema();
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
