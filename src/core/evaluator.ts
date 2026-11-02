import { randomUUID } from 'node:crypto';
import { isJiraRateLimited } from '../adapters/jira';
import type { Repo, TripwirePatch } from '../adapters/repo';
import { jqlGuard } from './extraction';
import type { Settings } from './settings';
import { EVALUABLE_STATUSES, nextState } from './state';
import type {
  CheckinSpec,
  ContentChangeSpec,
  DateSpec,
  EvaluationOutcome,
  JqlThresholdSpec,
  TriggerReading,
  TripwireStatus,
} from './types';

export interface EvalDeps {
  repo: Repo;
  readers: {
    jql_threshold: (spec: JqlThresholdSpec) => Promise<TriggerReading>;
    date: (spec: DateSpec, now: Date) => Promise<TriggerReading>;
    checkin: (spec: CheckinSpec, lastAnsweredAt: string | undefined, now: Date) => Promise<TriggerReading>;
    content_change: (spec: ContentChangeSpec, baseline?: number) => Promise<TriggerReading>;
  };
  openRevisit: (tripwireId: string) => Promise<unknown>;
  now: () => Date;
}

export type EvalOutcome =
  | { status: 'evaluated'; tripwireId: string; outcome: EvaluationOutcome; value: number | null; newStatus: TripwireStatus; revisitRequested: boolean }
  | { status: 'skipped'; tripwireId: string; reason: 'not_found' | 'not_evaluable' | 'kind_not_supported' | 'concurrent' }
  | { status: 'error'; tripwireId: string; message: string };

/** Max tripwires per `evaluate` queue event. */
export const BATCH_SIZE = 20;

/**
 * Jira answered 429 part-way through `evaluateMany`. `remaining` are the ids not evaluated yet (starting with
 * the one that hit the limit), so the caller can retry only those and never double-count a strike.
 */
export class EvaluationRateLimitedError extends Error {
  constructor(
    readonly remaining: string[],
    readonly done: EvalOutcome[],
  ) {
    super(`Jira rate limited the evaluation; ${remaining.length} tripwire(s) left`);
    this.name = 'EvaluationRateLimitedError';
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Reads one tripwire, records the evaluation, and moves it through the state machine. Numeric kinds need two
 * consecutive tripped readings to trip, date/checkin/content_change one (`strikesToTrip`); a tripped tripwire
 * asks `openRevisit` (which is idempotent) on every reading.
 * `settings` lets `evaluateMany` load them once; JQL is re-checked against the allowed projects before counting.
 */
export async function evaluateOne(tripwireId: string, deps: EvalDeps, settings?: Settings): Promise<EvalOutcome> {
  const { repo } = deps;
  const ctx = await repo.getTripwireContext(tripwireId);
  if (!ctx) return { status: 'skipped', tripwireId, reason: 'not_found' };
  const { tripwire } = ctx;
  if (!EVALUABLE_STATUSES.includes(tripwire.status)) return { status: 'skipped', tripwireId, reason: 'not_evaluable' };
  if (tripwire.kind === 'graph_relation') {
    console.info('tripwire evaluate: graph_relation is not supported yet', { tripwireId });
    return { status: 'skipped', tripwireId, reason: 'kind_not_supported' };
  }
  if (tripwire.kind === 'jql_threshold') {
    const allowed = (settings ?? (await repo.getSettings())).allowedProjectKeys;
    const guard = jqlGuard((tripwire.spec as JqlThresholdSpec).jql, allowed);
    if (!guard.ok) {
      console.warn('tripwire evaluate: jql no longer allowed', { tripwireId, reason: guard.reason });
      return { status: 'error', tripwireId, message: `jql not allowed: ${guard.reason}` };
    }
  }

  // A `revisiting` tripwire whose Revisit row never got written (crash, failed rollback) would wait forever:
  // treat it as `tripped` so this reading can retry `openRevisit`.
  // Same for one left on another tripwire's open Revisit (older rows, before `openRevisit` kept those `tripped`).
  let from = tripwire.status;
  if (from === 'revisiting') {
    const open = await repo.findOpenRevisit(ctx.decision.id);
    if (!open || (open.tripwireId !== undefined && open.tripwireId !== tripwireId)) {
      console.warn('tripwire evaluate: revisiting without an open revisit of its own, retrying as tripped', { tripwireId, otherRevisit: Boolean(open) });
      from = 'tripped';
    }
  }

  const now = deps.now();
  const nowIso = now.toISOString();
  let reading: TriggerReading;
  try {
    switch (tripwire.kind) {
      case 'jql_threshold':
        reading = await deps.readers.jql_threshold(tripwire.spec as JqlThresholdSpec);
        break;
      case 'date':
        reading = await deps.readers.date(tripwire.spec as DateSpec, now);
        break;
      case 'checkin':
        reading = await deps.readers.checkin(tripwire.spec as CheckinSpec, tripwire.confirmedAt, now);
        break;
      case 'content_change':
        reading = await deps.readers.content_change(tripwire.spec as ContentChangeSpec, tripwire.baselineVersion ?? undefined);
        break;
    }
  } catch (err) {
    if (isJiraRateLimited(err)) throw err;
    console.warn('tripwire evaluate: reading failed', { tripwireId, error: errorMessage(err) });
    return { status: 'error', tripwireId, message: errorMessage(err) };
  }

  const next = nextState({ status: from, strikes: tripwire.strikes }, reading.outcome, tripwire.kind);
  // Starting points a tripwire may lack (older rows): a check-in without an answer counts from now, and a
  // watched page without a baseline starts from the version just read. Neither trips on this reading.
  const starts: TripwirePatch = {};
  if (tripwire.kind === 'checkin' && !tripwire.confirmedAt) starts.confirmedAt = nowIso;
  if (tripwire.kind === 'content_change' && tripwire.baselineVersion === null && reading.value !== null) starts.baselineVersion = reading.value;
  // CAS first (status + strikes): a run that lost the race must not leave an evaluation row behind.
  const ok = await repo.casTripwire(
    tripwireId,
    [tripwire.status],
    { status: next.status, strikes: next.strikes, lastValue: reading.value, lastOutcome: reading.outcome, lastEvaluatedAt: nowIso, ...starts },
    { strikes: tripwire.strikes },
  );
  if (!ok) return { status: 'skipped', tripwireId, reason: 'concurrent' };
  try {
    await repo.insertEvaluation({
      id: randomUUID(),
      tripwireId,
      value: reading.value,
      outcome: reading.outcome,
      evaluatedAt: nowIso,
      detail: reading.detail?.slice(0, 255),
    });
  } catch (err) {
    // The state already moved; losing one history row must not stop the Revisit below.
    console.error('tripwire evaluate: evaluation row not saved', { tripwireId, error: errorMessage(err) });
  }
  if (next.openRevisit) await deps.openRevisit(tripwireId);
  return { status: 'evaluated', tripwireId, outcome: reading.outcome, value: reading.value, newStatus: next.status, revisitRequested: next.openRevisit };
}

/** Evaluates sequentially. A Jira 429 stops the run with `EvaluationRateLimitedError` listing the ids still to do. */
export async function evaluateMany(ids: readonly string[], deps: EvalDeps): Promise<EvalOutcome[]> {
  const results: EvalOutcome[] = [];
  const settings = ids.length > 0 ? await deps.repo.getSettings() : undefined;
  for (const [index, id] of ids.entries()) {
    try {
      results.push(await evaluateOne(id, deps, settings));
    } catch (err) {
      if (isJiraRateLimited(err)) throw new EvaluationRateLimitedError(ids.slice(index), results);
      console.error('tripwire evaluate failed', { tripwireId: id, error: errorMessage(err) });
      results.push({ status: 'error', tripwireId: id, message: errorMessage(err) });
    }
  }
  return results;
}

/** Counts for logs and the setup page. */
export function summarise(results: readonly EvalOutcome[]): { evaluated: number; skipped: number; errors: number; revisits: number } {
  return {
    evaluated: results.filter((r) => r.status === 'evaluated').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errors: results.filter((r) => r.status === 'error').length,
    revisits: results.filter((r) => r.status === 'evaluated' && r.revisitRequested).length,
  };
}
