import { isForgePlatformError } from '@forge/api';
import Resolver from '@forge/resolver';
import { confluence } from '../adapters/confluence';
import { jira, JiraUnavailableError } from '../adapters/jira';
import { sqlRepo, type DecisionRow, type EvaluationRow, type RevisitRow, type TripwirePatch, type TripwireRow } from '../adapters/repo';
import { demoSettings, listDemoPageIds, SeedError } from '../adapters/seed';
import { ensureSchema, listAppliedMigrations } from '../adapters/sql';
import { EvaluationRateLimitedError, evaluateMany, summarise, type EvalOutcome } from '../core/evaluator';
import { jqlGuard, toCheckin } from '../core/extraction';
import { LATEST_MIGRATION, MIGRATIONS } from '../core/migrations';
import { SchemaSettingUpError } from '../core/schema';
import { reaffirmRevisit, suggestThreshold, type ReaffirmInput } from '../core/revisit';
import { normaliseSettings, SettingsError, type Settings } from '../core/settings';
import { EVALUABLE_STATUSES } from '../core/state';
import { validateSpec } from '../core/triggers';
import type { Assumption, JqlThresholdSpec } from '../core/types';
import { asUserGraph, cloudIdFromInstallContext, fetchPairGraph } from '../adapters/teamworkGraph';
import { randomUUID } from 'node:crypto';
import { enqueueDemoJob, enqueueExtraction, enqueueLlmProbe, enqueueRadarScan, evalDeps, RADAR_LAST_SCAN_KEY } from './background';
import { DEMO_JOB_LABELS, isActive, publicJob, readDemoJob, startDemoJob, type DemoJobDeps, type DemoJobKind, type PublicDemoJob } from './demoJob';
import { stampDemoReviews, type StampResult } from './demoStamp';
import { radarGraphContextWith, radarListWith, RadarNotFoundError, type RadarViewDeps } from './radar';

const resolver = new Resolver();

export type ResolverContext = {
  accountId?: string;
  moduleKey?: string;
  cloudId?: string;
  installContext?: string;
  extension?: { content?: { id?: string | number }; issue?: { key?: string } };
};

const SETUP_MODULE = 'tripwire-setup';
const BYLINE_MODULE = 'tripwire-byline';
const REVISIT_MODULE = 'tripwire-revisit';
const HEALTH_MODULE = 'tripwire-health';

const MODULE_NAMES: Record<string, string> = { [SETUP_MODULE]: 'Tripwire setup', [HEALTH_MODULE]: 'Decision Health' };

/** Placeholder status shown by every Custom UI view until the real queries land. */
resolver.define('getStatus', ({ context }: { context: ResolverContext }) => ({
  app: 'Tripwire',
  moduleKey: context.moduleKey ?? null,
  watched: 0,
  tripped: 0,
}));

interface AdminCheck {
  allowed: (accountId: string) => Promise<boolean>;
  /** Who may do it, for the refusal message. */
  who: string;
}

/** Reply while the database is still being set up (new install): a readable message, never "failed". */
export function settingUpReply(err: unknown): { error: string; settingUp: true; applied: number; total: number } | undefined {
  if (!(err instanceof SchemaSettingUpError)) return undefined;
  return { error: err.message, settingUp: true, applied: err.applied, total: err.total };
}

const JIRA_ADMINS: AdminCheck = { allowed: (accountId) => jira.isAdmin(accountId), who: 'Jira administrators' };

/**
 * Runs `body` only for admins (default: Jira admins) on one of `modules` (default: the setup page); failures
 * become `{ error }` replies for the UI bridge.
 */
async function adminOnly<T>(
  context: unknown,
  action: string,
  body: () => Promise<T>,
  modules: readonly string[] = [SETUP_MODULE],
  check: AdminCheck = JIRA_ADMINS,
): Promise<T | { error: string }> {
  const ctx = context as ResolverContext;
  if (!ctx.moduleKey || !modules.includes(ctx.moduleKey) || !ctx.accountId) {
    return { error: `${action} is only available on ${modules.map((m) => MODULE_NAMES[m] ?? m).join(' or ')}.` };
  }
  try {
    if (!(await check.allowed(ctx.accountId))) return { error: `Only ${check.who} can ${action.toLowerCase()}.` };
    return await body();
  } catch (err) {
    if (err instanceof SettingsError || err instanceof SeedError) return { error: err.message };
    const settingUp = settingUpReply(err);
    if (settingUp) return settingUp;
    console.error(`Tripwire ${action} failed`, err);
    return { error: `${action} failed. Check the app logs.` };
  }
}

resolver.define('initialise', ({ context }) =>
  adminOnly(context, 'Initialise', async () => {
    try {
      await ensureSchema();
    } catch (err) {
      // New install: the `schema-migrate` consumer is still applying migrations (paced for the DDL rate limit).
      if (!(err instanceof SchemaSettingUpError)) throw err;
      return { settingUp: true, applied: err.applied, total: err.total, latest: LATEST_MIGRATION };
    }
    const applied = await listAppliedMigrations();
    return { applied, total: MIGRATIONS.length, latest: LATEST_MIGRATION };
  }),
);

resolver.define('getSettings', ({ context }) =>
  adminOnly(context, 'Read settings', async (): Promise<Settings> => {
    await ensureSchema();
    return sqlRepo.getSettings();
  }),
);

resolver.define('saveSettings', ({ payload, context }) =>
  adminOnly(context, 'Save settings', async (): Promise<Settings> => {
    const settings = normaliseSettings(payload);
    await ensureSchema();
    await sqlRepo.saveSettings(settings);
    return settings;
  }),
);

resolver.define('probeLlm', ({ context }) =>
  adminOnly(context, 'Test LLM', async () => ({ jobId: await enqueueLlmProbe() })),
);

/** Max tripwires "Run evaluation now" evaluates inline (one approximate-count each, within the 25 s resolver limit). */
const RUN_NOW_LIMIT = 100;

resolver.define('runEvaluationNow', ({ context }) =>
  adminOnly(context, 'Run evaluation', async () => {
    await ensureSchema();
    const ids = await sqlRepo.listTripwireIdsForEvaluation(EVALUABLE_STATUSES, RUN_NOW_LIMIT + 1, 0);
    const truncated = ids.length > RUN_NOW_LIMIT;
    const selected = ids.slice(0, RUN_NOW_LIMIT);
    let results: EvalOutcome[];
    let rateLimited = false;
    try {
      results = await evaluateMany(selected, evalDeps);
    } catch (err) {
      if (!(err instanceof EvaluationRateLimitedError)) throw err;
      results = err.done;
      rateLimited = true;
    }
    console.info('tripwire runEvaluationNow', { ...summarise(results), total: selected.length, truncated, rateLimited });
    return { ...summarise(results), total: selected.length, truncated, rateLimited };
  }),
);

// --- Demo data ------------------------------------------------------------------------------------

const demoJobDeps = (): DemoJobDeps => ({ repo: sqlRepo, push: enqueueDemoJob, now: () => Date.now(), newId: () => randomUUID() });

/** Which remembered demo pages the caller can edit (asUser), for the consumer that cannot ask Confluence as them. */
async function demoPageAccess(): Promise<{ editable: string[]; checked: string[] }> {
  const ids = await listDemoPageIds(sqlRepo);
  const results = await Promise.all(
    ids.map(async (pageId) => {
      try {
        return { pageId, canEdit: await confluence.canEditPage(pageId) };
      } catch (err) {
        console.warn('tripwire demo: could not check page access', { pageId, error: err instanceof Error ? err.message : String(err) });
        return { pageId, canEdit: undefined };
      }
    }),
  );
  return {
    editable: results.filter((r) => r.canEdit === true).map((r) => r.pageId),
    checked: results.filter((r) => r.canEdit !== undefined).map((r) => r.pageId),
  };
}

/** Validates, then queues the demo job (or returns the one already running); the work runs in the `demo-seed` consumer. */
function startDemo(context: unknown, kind: DemoJobKind) {
  return adminOnly(context, DEMO_JOB_LABELS[kind], async () => {
    await ensureSchema();
    const accountId = (context as ResolverContext).accountId as string;
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId)) throw new SeedError('Unknown user.');
    // Same check Load runs before creating anything, so a bad setting fails on the click instead of in the job.
    if (kind === 'load') demoSettings(await sqlRepo.getSettings());
    const started = await startDemoJob(kind, accountId, kind === 'reset' ? async () => ({ editable: [], checked: [] }) : demoPageAccess, demoJobDeps());
    if ('job' in started) console.info('tripwire demo job', { kind, jobId: started.job.id, started: started.started, status: started.job.status });
    return started;
  });
}

resolver.define('loadDemoData', ({ context }) => startDemo(context, 'load'));
resolver.define('simulateBusyMonth', ({ context }) => startDemo(context, 'simulate'));
resolver.define('resetDemo', ({ context }) => startDemo(context, 'reset'));

/**
 * Called by the setup page once "Load demo data" is done: adds "Reviewed by <admin>." to the demo pages as the
 * admin (a queue consumer cannot act as a user), so Teamwork Graph sees a human contributor on each page.
 */
resolver.define('stampDemoReviews', ({ context }) =>
  adminOnly(context, 'Add demo review notes', async (): Promise<StampResult> => {
    await ensureSchema();
    const job = await readDemoJob(demoJobDeps());
    if (job && isActive(job)) throw new SeedError('A demo job is still running, try again when it is done.');
    const accountId = (context as ResolverContext).accountId as string;
    const result = await stampDemoReviews(await listDemoPageIds(sqlRepo), accountId, {
      repo: sqlRepo,
      canEdit: (pageId) => confluence.canEditPage(pageId),
      getPage: (pageId) => confluence.getPageAsUser(pageId),
      updatePage: (pageId, page) => confluence.updatePageAsUser(pageId, page),
      now: () => Date.now(),
    });
    console.info('tripwire stampDemoReviews', result);
    return result;
  }),
);

/** Polled by the setup page while a demo job runs; also tells a reopened page about a job still running. */
resolver.define('getDemoJob', ({ context }) =>
  adminOnly(context, 'Read demo job', async (): Promise<{ job: PublicDemoJob | null }> => {
    await ensureSchema();
    const job = await readDemoJob(demoJobDeps());
    if (!job) return { job: null };
    const view = publicJob(job);
    // The consumer could not check access to a page Load just created: check it now, as the admin.
    const result = view.result as { pageId?: unknown; canEdit?: unknown } | undefined;
    if (view.kind === 'load' && view.status === 'done' && result && result.canEdit === null && typeof result.pageId === 'string') {
      try {
        return { job: { ...view, result: { ...result, canEdit: await confluence.canEditPage(result.pageId) } } };
      } catch (err) {
        console.warn('tripwire getDemoJob: could not check page access', { pageId: result.pageId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { job: view };
  }),
);

// --- Decision Health → Radar -----------------------------------------------------------------------

/** Minimum seconds between two "Scan now" requests. */
export const RADAR_SCAN_COOLDOWN_SECONDS = 60;
const RADAR_REQUEST_LOCK = 'radar-scan-request';

const radarViewDeps = (): RadarViewDeps => ({
  repo: sqlRepo,
  viewPage: (pageId) => confluence.viewPageAsUser(pageId),
  isPlatformError: (err) => err instanceof Error && isForgePlatformError(err),
  now: () => new Date(),
});

/**
 * Radar managers (dismiss, scan now): Jira admins. Jira is optional, so when it cannot be reached as the app (not
 * installed, or the call is refused) the check falls back to Confluence: a user who may administer one of the
 * watched spaces. Fails closed: any error in the fallback means "no".
 */
export async function canManageRadar(accountId: string): Promise<boolean> {
  try {
    return await jira.isAdmin(accountId);
  } catch (err) {
    if (!(err instanceof JiraUnavailableError)) throw err;
    console.info('tripwire radar: Jira unavailable, checking Confluence space admin', { error: err.message.slice(0, 200) });
  }
  try {
    await ensureSchema();
    const { watchedSpaceKeys } = await sqlRepo.getSettings();
    for (const key of watchedSpaceKeys.slice(0, 10)) {
      const space = await confluence.findSpace(key);
      if (space && (await confluence.canAdministerSpace(space.id))) return true;
    }
    return false;
  } catch (err) {
    console.warn('tripwire radar: Confluence space admin check failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

const RADAR_MANAGERS: AdminCheck = { allowed: canManageRadar, who: 'Jira administrators (or, without Jira, admins of a watched space)' };

/** Site id of the invocation: `cloudId`, else parsed from `installContext`. */
export function siteIdOf(ctx: ResolverContext): string | undefined {
  return ctx.cloudId || cloudIdFromInstallContext(ctx.installContext);
}

/** Runs `body` for anyone on Decision Health; platform errors (e.g. missing consent) are rethrown for the bridge. */
async function onHealth<T>(context: unknown, action: string, body: (ctx: ResolverContext & { accountId: string }) => Promise<T>): Promise<T | { error: string }> {
  const ctx = context as ResolverContext;
  if (ctx.moduleKey !== HEALTH_MODULE || !ctx.accountId) return { error: `${action} is only available on Decision Health.` };
  try {
    await ensureSchema();
    return await body({ ...ctx, accountId: ctx.accountId });
  } catch (err) {
    if (err instanceof RadarNotFoundError) return { error: err.message };
    const settingUp = settingUpReply(err);
    if (settingUp) return settingUp;
    if (err instanceof Error && isForgePlatformError(err)) throw err;
    console.error(`Tripwire ${action} failed`, err);
    return { error: `${action} failed. Check the app logs.` };
  }
}

resolver.define('radarList', ({ context }) =>
  onHealth(context, 'Load Radar', async (ctx) => {
    const canManage = await canManageRadar(ctx.accountId).catch(() => false);
    return radarListWith(radarViewDeps(), canManage, RADAR_LAST_SCAN_KEY);
  }),
);

resolver.define('radarGraphContext', ({ payload, context }) =>
  onHealth(context, 'Load graph context', async (ctx) => {
    const pairId = (payload as { pairId?: unknown } | undefined)?.pairId;
    if (typeof pairId !== 'string' || pairId === '') return { error: 'pairId is required.' };
    const cloudId = siteIdOf(ctx);
    // Space ids are read as the app: `radarGraphContextWith` only fetches after the user passed the view check of both pages.
    const spaceOf = async (pageId: string) => (await confluence.getPage(pageId)).spaceId || undefined;
    const fetchGraph = cloudId ? (a: string, b: string) => fetchPairGraph(asUserGraph(cloudId), cloudId, a, b, spaceOf) : undefined;
    return { pair: await radarGraphContextWith(pairId, radarViewDeps(), fetchGraph) };
  }),
);

resolver.define('radarDismiss', ({ payload, context }) =>
  adminOnly(
    context,
    'Dismiss Radar pair',
    async () => {
      const pairId = (payload as { pairId?: unknown } | undefined)?.pairId;
      if (typeof pairId !== 'string' || pairId === '') return { error: 'pairId is required.' };
      await ensureSchema();
      if (!(await sqlRepo.setRadarPairStatus(pairId, ['open'], 'dismissed'))) return { error: 'This Radar pair is no longer open.' };
      console.info('tripwire radar dismiss', { pairId });
      return { dismissed: pairId };
    },
    [HEALTH_MODULE],
    RADAR_MANAGERS,
  ),
);

resolver.define('radarScanNow', ({ context }) =>
  adminOnly(
    context,
    'Scan for contradictions',
    async () => {
      await ensureSchema();
      if (!(await sqlRepo.acquireAppLock(RADAR_REQUEST_LOCK, new Date().toISOString(), RADAR_SCAN_COOLDOWN_SECONDS))) {
        return { error: `A scan was requested less than ${RADAR_SCAN_COOLDOWN_SECONDS} seconds ago. Try again in a minute.` };
      }
      return { jobId: await enqueueRadarScan('manual') };
    },
    [HEALTH_MODULE],
    RADAR_MANAGERS,
  ),
);

// --- Confluence byline -----------------------------------------------------------------------------

export interface DecisionView {
  decision?: DecisionRow;
  assumptions: { assumption: Assumption; tripwire: TripwireRow; evaluations: EvaluationRow[]; revisit?: RevisitRow }[];
  state: 'none' | 'ready' | 'error';
  /** Whether the viewer may edit the page, i.e. scan it and confirm tripwires. */
  canEdit: boolean;
}

/** Minimum seconds between two Scan requests for the same page. */
export const SCAN_COOLDOWN_SECONDS = 60;

/**
 * Proposed tripwires are drafts: their first count ran as the app before anyone checked the JQL. Viewers who
 * cannot edit the page see the assumption and spec, but no reading or history.
 */
export function redactProposed(rows: DecisionView['assumptions'], canEdit: boolean): DecisionView['assumptions'] {
  if (canEdit) return rows;
  return rows.map((row) =>
    row.tripwire.status === 'proposed'
      ? { ...row, tripwire: { ...row.tripwire, lastValue: null, lastOutcome: null, lastEvaluatedAt: null }, evaluations: [] }
      : row,
  );
}

async function requireEditor(pageId: string, action: string): Promise<void> {
  if (!(await confluence.canEditPage(pageId))) throw new UserError(`Only people who can edit this page can ${action}.`);
}

class UserError extends Error {}

/** Runs `body` only from the byline with a known page and user; failures become `{ error }` replies. */
async function onPage<T>(
  context: unknown,
  action: string,
  body: (pageId: string, accountId: string) => Promise<T>,
): Promise<T | { error: string }> {
  const ctx = context as ResolverContext;
  const pageId = ctx.extension?.content?.id;
  if (ctx.moduleKey !== BYLINE_MODULE || pageId === undefined || !ctx.accountId) {
    console.warn(`Tripwire ${action}: missing page context`, { moduleKey: ctx.moduleKey, extensionKeys: Object.keys(ctx.extension ?? {}) });
    return { error: `${action} is only available on a Confluence page.` };
  }
  try {
    await ensureSchema();
    return await body(String(pageId), ctx.accountId);
  } catch (err) {
    if (err instanceof UserError) return { error: err.message };
    const settingUp = settingUpReply(err);
    if (settingUp) return settingUp;
    // e.g. NeedsAuthenticationError from asUser(): the bridge turns it into the consent prompt.
    if (err instanceof Error && isForgePlatformError(err)) throw err;
    console.error(`Tripwire ${action} failed`, err);
    return { error: `${action} failed. Check the app logs.` };
  }
}

resolver.define('getDecision', ({ context }) =>
  onPage(context, 'Load decision', async (pageId): Promise<DecisionView> => {
    const [decision, canEdit] = await Promise.all([sqlRepo.getDecisionByPage(pageId), confluence.canEditPage(pageId)]);
    if (!decision) return { assumptions: [], state: 'none', canEdit };
    const [assumptions, tripwires, revisit] = await Promise.all([
      sqlRepo.listAssumptions(decision.id),
      sqlRepo.listTripwires(decision.id),
      sqlRepo.findOpenRevisit(decision.id),
    ]);
    const byId = new Map(assumptions.map((a) => [a.id, a]));
    const rows: DecisionView['assumptions'] = [];
    for (const tripwire of tripwires) {
      const assumption = byId.get(tripwire.assumptionId);
      if (!assumption) continue;
      const evaluations = tripwire.status === 'proposed' && !canEdit ? [] : await sqlRepo.listEvaluations(tripwire.id, 10);
      rows.push({ assumption, tripwire, evaluations, ...(revisit && revisit.tripwireId === tripwire.id ? { revisit } : {}) });
    }
    const state = decision.extractError ? 'error' : decision.extractedAt ? 'ready' : 'none';
    return { decision, assumptions: redactProposed(rows, canEdit), state, canEdit };
  }),
);

resolver.define('scanPage', ({ payload, context }) =>
  onPage(context, 'Scan page', async (pageId, accountId) => {
    await requireEditor(pageId, 'scan it');
    if (!(await sqlRepo.acquirePageLock(pageId, 'scan', new Date().toISOString(), SCAN_COOLDOWN_SECONDS))) {
      throw new UserError(`This page was scanned less than ${SCAN_COOLDOWN_SECONDS} seconds ago. Try again in a minute.`);
    }
    return { jobId: await enqueueExtraction(pageId, (payload as { force?: unknown } | undefined)?.force === true, accountId) };
  }),
);

async function checkedJql(spec: JqlThresholdSpec): Promise<JqlThresholdSpec> {
  const guard = jqlGuard(spec.jql, (await sqlRepo.getSettings()).allowedProjectKeys);
  if (!guard.ok) throw new UserError(`JQL not allowed: ${guard.reason}`);
  const parsed = await jira.parseJql(guard.jql);
  if (!parsed.ok) throw new UserError(`Jira rejected the JQL: ${parsed.errors.join('; ')}`);
  return { ...spec, jql: guard.jql };
}

resolver.define('confirmTripwire', ({ payload, context }) =>
  onPage(context, 'Confirm tripwire', async (pageId, accountId): Promise<{ tripwire: TripwireRow }> => {
    const input = (payload ?? {}) as { tripwireId?: unknown; action?: unknown; spec?: unknown };
    if (typeof input.tripwireId !== 'string') throw new UserError('tripwireId is required.');
    const found = await sqlRepo.getTripwireContext(input.tripwireId);
    if (!found || found.decision.pageId !== pageId) throw new UserError('Tripwire not found on this page.');
    await requireEditor(pageId, 'confirm tripwires');
    const { tripwire, assumption, decision } = found;

    const confirmed = { status: 'active' as const, confirmedBy: accountId, confirmedAt: new Date().toISOString() };
    let patch: TripwirePatch;
    switch (input.action) {
      case 'accept':
        patch = { ...confirmed, baselineVersion: tripwire.kind === 'content_change' ? (decision.pageVersion ?? null) : null };
        break;
      case 'edit': {
        const valid = validateSpec(tripwire.kind, input.spec);
        if (!valid.ok) throw new UserError(`Invalid spec: ${valid.errors.join('; ')}`);
        let spec = valid.spec as TripwireRow['spec'];
        if (tripwire.kind === 'jql_threshold') spec = await checkedJql(spec as JqlThresholdSpec);
        if (tripwire.kind === 'content_change' && (spec as { pageId: string }).pageId !== pageId) {
          throw new UserError('A content_change tripwire can only watch this page.');
        }
        patch = {
          ...confirmed,
          spec,
          lastValue: null,
          lastOutcome: null,
          lastEvaluatedAt: null,
          baselineVersion: tripwire.kind === 'content_change' ? (decision.pageVersion ?? null) : null,
        };
        break;
      }
      case 'checkin':
        patch = { ...confirmed, kind: 'checkin', spec: toCheckin(assumption.summary), lastValue: null, lastOutcome: null, lastEvaluatedAt: null, baselineVersion: null };
        break;
      default:
        throw new UserError('action must be accept, edit or checkin.');
    }
    if (!(await sqlRepo.casTripwire(tripwire.id, ['proposed'], patch))) throw new UserError('This tripwire was already confirmed.');
    const saved = await sqlRepo.getTripwireContext(tripwire.id);
    if (!saved) throw new Error(`Tripwire ${tripwire.id} disappeared after confirm`);
    return { tripwire: saved.tripwire };
  }),
);

// --- Jira issue panel -----------------------------------------------------------------------------

resolver.define('getRevisit', async ({ context }) => {
  const ctx = context as ResolverContext;
  const issueKey = ctx.extension?.issue?.key;
  if (ctx.moduleKey !== REVISIT_MODULE || !issueKey) return { error: 'Decision revisit is only available on a Jira work item.' };
  try {
    await ensureSchema();
    const revisit = await sqlRepo.getRevisitByIssue(issueKey);
    const found = revisit?.tripwireId ? await sqlRepo.getTripwireContext(revisit.tripwireId) : undefined;
    if (!revisit || !found) return { error: 'This work item is not a Tripwire revisit task.' };
    // The decision, assumption, JQL and readings come from a Confluence page: only show them to people who can view it.
    let page: Awaited<ReturnType<typeof confluence.viewPageAsUser>>;
    try {
      page = await confluence.viewPageAsUser(found.decision.pageId);
    } catch (err) {
      if (err instanceof Error && isForgePlatformError(err)) throw err;
      console.warn('Tripwire getRevisit: page access check failed', { pageId: found.decision.pageId, error: String(err) });
      page = undefined;
    }
    if (!page) return restrictedRevisit(revisit);
    const evaluations = await sqlRepo.listEvaluations(found.tripwire.id, 30);
    return { revisit, ...found, evaluations, pageUrl: page.webUrl, suggestedThreshold: suggestedFor(found.tripwire) };
  } catch (err) {
    // e.g. NeedsAuthenticationError from asUser(): the bridge turns it into the consent prompt.
    if (err instanceof Error && isForgePlatformError(err)) throw err;
    const settingUp = settingUpReply(err);
    if (settingUp) return settingUp;
    console.error('Tripwire Load revisit failed', err);
    return { error: 'Load revisit failed. Check the app logs.' };
  }
});

export const NO_PAGE_ACCESS = "You don't have access to the decision page.";

/** Revisit view for someone who cannot view the decision page: status only, nothing taken from the page. */
export function restrictedRevisit(revisit: RevisitRow): { restricted: true; message: string; revisit: Pick<RevisitRow, 'issueKey' | 'status' | 'createdAt'> } {
  return { restricted: true, message: NO_PAGE_ACCESS, revisit: { issueKey: revisit.issueKey, status: revisit.status, createdAt: revisit.createdAt } };
}

function suggestedFor(tripwire: TripwireRow): number | undefined {
  if (tripwire.kind !== 'jql_threshold' && tripwire.kind !== 'graph_relation') return undefined;
  return suggestThreshold(tripwire.lastValue, (tripwire.spec as { value: number }).value);
}

resolver.define('reaffirmRevisit', async ({ payload, context }) => {
  const ctx = context as ResolverContext;
  // The issue comes from the panel context, never from the payload.
  const issueKey = ctx.extension?.issue?.key;
  if (ctx.moduleKey !== REVISIT_MODULE || !issueKey || !ctx.accountId) return { error: 'Reaffirm is only available on a Jira work item.' };
  try {
    await ensureSchema();
    const input = (payload ?? {}) as ReaffirmInput;
    return await reaffirmRevisit(issueKey, ctx.accountId, { newThreshold: input.newThreshold, note: input.note }, {
      repo: sqlRepo,
      jira,
      canEditPage: (pageId) => confluence.canEditPage(pageId),
      pageVersion: (pageId) => confluence.getPageVersion(pageId),
    });
  } catch (err) {
    if (err instanceof Error && isForgePlatformError(err)) throw err;
    const settingUp = settingUpReply(err);
    if (settingUp) return settingUp;
    console.error('Tripwire Reaffirm failed', err);
    return { error: 'Reaffirm failed. Check the app logs.' };
  }
});

export const handler = resolver.getDefinitions();
