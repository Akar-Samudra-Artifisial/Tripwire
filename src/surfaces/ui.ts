import { isForgePlatformError } from '@forge/api';
import Resolver from '@forge/resolver';
import { confluence } from '../adapters/confluence';
import { jira } from '../adapters/jira';
import { sqlRepo, type DecisionRow, type EvaluationRow, type RevisitRow, type TripwirePatch, type TripwireRow } from '../adapters/repo';
import { loadDemoData, resetDemo, SeedError, simulateBusyMonth, type SeedDeps } from '../adapters/seed';
import { ensureSchema, listAppliedMigrations } from '../adapters/sql';
import { EvaluationRateLimitedError, evaluateMany, summarise, type EvalOutcome } from '../core/evaluator';
import { jqlGuard, toCheckin } from '../core/extraction';
import { LATEST_MIGRATION } from '../core/migrations';
import { reaffirmRevisit, suggestThreshold, type ReaffirmInput } from '../core/revisit';
import { normaliseSettings, SettingsError, type Settings } from '../core/settings';
import { EVALUABLE_STATUSES } from '../core/state';
import { validateSpec } from '../core/triggers';
import type { Assumption, JqlThresholdSpec } from '../core/types';
import { enqueueExtraction, enqueueLlmProbe, evalDeps } from './background';

const resolver = new Resolver();

type ResolverContext = {
  accountId?: string;
  moduleKey?: string;
  extension?: { content?: { id?: string | number }; issue?: { key?: string } };
};

const SETUP_MODULE = 'tripwire-setup';
const BYLINE_MODULE = 'tripwire-byline';
const REVISIT_MODULE = 'tripwire-revisit';

/** Placeholder status shown by every Custom UI view until the real queries land. */
resolver.define('getStatus', ({ context }: { context: ResolverContext }) => ({
  app: 'Tripwire',
  moduleKey: context.moduleKey ?? null,
  watched: 0,
  tripped: 0,
}));

/** Runs `body` only for Jira admins on the setup page; failures become `{ error }` replies for the UI bridge. */
async function adminOnly<T>(context: unknown, action: string, body: () => Promise<T>): Promise<T | { error: string }> {
  const ctx = context as ResolverContext;
  if (ctx.moduleKey !== SETUP_MODULE || !ctx.accountId) return { error: `${action} is only available on Tripwire setup.` };
  try {
    if (!(await jira.isAdmin(ctx.accountId))) return { error: `Only Jira administrators can ${action.toLowerCase()}.` };
    return await body();
  } catch (err) {
    if (err instanceof SettingsError || err instanceof SeedError) return { error: err.message };
    console.error(`Tripwire ${action} failed`, err);
    return { error: `${action} failed. Check the app logs.` };
  }
}

resolver.define('initialise', ({ context }) =>
  adminOnly(context, 'Initialise', async () => {
    await ensureSchema();
    return { applied: await listAppliedMigrations(), latest: LATEST_MIGRATION };
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

const seedDeps: SeedDeps = {
  jira,
  confluence,
  repo: sqlRepo,
  enqueueExtraction,
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

resolver.define('loadDemoData', ({ context }) =>
  adminOnly(context, 'Load demo data', async () => {
    await ensureSchema();
    const result = await loadDemoData((context as ResolverContext).accountId as string, seedDeps);
    console.info('tripwire loadDemoData', { pageId: result.pageId, issueCount: result.issueCount, created: result.created });
    return result;
  }),
);

resolver.define('simulateBusyMonth', ({ context }) =>
  adminOnly(context, 'Simulate a busy month', async () => {
    await ensureSchema();
    const result = await simulateBusyMonth(seedDeps);
    console.info('tripwire simulateBusyMonth', { created: result.created, issueCount: result.issueCount, indexed: result.indexed, complete: result.complete, passes: result.passes, revisits: result.revisits.length });
    return result;
  }),
);

resolver.define('resetDemo', ({ context }) =>
  adminOnly(context, 'Reset demo', async () => {
    await ensureSchema();
    const result = await resetDemo((context as ResolverContext).accountId as string, seedDeps);
    console.info('tripwire resetDemo', { ...result, warnings: result.warnings.length });
    return result;
  }),
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
    });
  } catch (err) {
    if (err instanceof Error && isForgePlatformError(err)) throw err;
    console.error('Tripwire Reaffirm failed', err);
    return { error: 'Reaffirm failed. Check the app logs.' };
  }
});

export const handler = resolver.getDefinitions();
