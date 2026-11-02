import { randomUUID } from 'node:crypto';
import { JiraError, JiraUnavailableError, type AdfDoc, type jira } from '../adapters/jira';
import type { DecisionRow, EvaluationRow, Repo, RevisitRow, TripwireContext, TripwirePatch } from '../adapters/repo';
import { describeSpec, describeValue, formatReading } from './describe';
import { PERIOD_DAYS } from './triggers/checkin';
import type { CheckinSpec, DateSpec, TripwireKind } from './types';

export type { AdfDoc };

export interface RevisitDeps {
  repo: Repo;
  jira: Pick<typeof jira, 'createIssue' | 'getProject'>;
  now: () => Date;
  /** Web URL of the decision page for the issue description; optional so a Confluence failure never blocks a Revisit. */
  pageUrl?: (pageId: string) => Promise<string | undefined>;
}

export type OpenRevisitResult =
  | { created: true; issueKey: string; url: string }
  | {
      created: false;
      reason:
        | 'not_found'
        | 'not_tripped'
        | 'concurrent'
        | 'decision_locked'
        | 'already_open'
        | 'no_project'
        | 'jira_unavailable'
        | 'jira_error';
      issueKey?: string;
      message?: string;
    };

export const REVISIT_LABELS = ['tripwire', 'decision-revisit'];
const SUMMARY_STATEMENT_MAX = 80;
const TEXT_MAX = 1000;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `Revisit decision: <statement>`, statement cut to 80 characters, at most 255 overall (Jira summary limit). */
export function revisitSummary(decision: DecisionRow): string {
  const statement = (decision.statement || decision.title || 'untitled decision').replace(/\s+/g, ' ').trim();
  return cut(`Revisit decision: ${cut(statement, SUMMARY_STATEMENT_MAX)}`, 255);
}

// ADF builders. Page/LLM text only ever enters as `text` nodes, never as markup.
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: cut(value, TEXT_MAX), ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const heading = (value: string) => ({ type: 'heading', attrs: { level: 3 }, content: [text(value)] });
const bullets = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [paragraph(text(item))] })),
});

/** Leading run of tripped evaluations (newest first) = consecutive readings that held the condition. */
function trippedRun(evaluations: readonly EvaluationRow[]): number {
  let n = 0;
  for (const e of evaluations) {
    if (e.outcome !== 'tripped') break;
    n += 1;
  }
  return n;
}

const REAFFIRM_HINT: Record<TripwireKind, string> = {
  jql_threshold: 'reaffirm with a new threshold',
  graph_relation: 'reaffirm with a new threshold',
  checkin: 'answer "Still true"',
  content_change: 'accept the page changes',
  date: 'mark the date as handled',
};

/** Description of the Revisit work item: decision, assumption, tripwire, evidence and next step. */
export function revisitDescription(ctx: TripwireContext, evaluations: readonly EvaluationRow[], pageUrl?: string): AdfDoc {
  const { decision, assumption, tripwire } = ctx;
  const statement = decision.statement || decision.title || 'Untitled decision';
  const decisionParagraph = pageUrl
    ? paragraph(text(statement), text(' — '), text('open decision page', [{ type: 'link', attrs: { href: pageUrl } }]))
    : paragraph(text(statement));
  const held = Math.max(trippedRun(evaluations), tripwire.strikes);
  const history = evaluations.slice(0, 5).map((e) => `${e.evaluatedAt.slice(0, 10)} · ${describeValue(tripwire.kind, tripwire.spec, e.value)} · ${e.outcome}`);
  return {
    type: 'doc',
    version: 1,
    content: [
      heading('Decision'),
      decisionParagraph,
      heading('Assumption'),
      { type: 'blockquote', content: [paragraph(text(assumption.quote))] },
      paragraph(text(assumption.summary)),
      heading('Tripwire'),
      paragraph(text(describeSpec(tripwire.kind, tripwire.spec))),
      heading('Evidence'),
      paragraph(text(formatReading(tripwire))),
      paragraph(text(`Condition held on ${held} consecutive evaluations.`)),
      ...(history.length > 0 ? [bullets(history)] : []),
      heading('What to do'),
      paragraph(text(`Open the Decision revisit panel on this work item to ${REAFFIRM_HINT[tripwire.kind]} or supersede the decision.`)),
    ],
  };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Longer than one `openRevisit` can take; a crashed holder frees the decision by itself. */
export const REVISIT_LOCK_SECONDS = 5 * 60;

/**
 * Opens one Jira Revisit task for a tripped tripwire. Idempotent in four layers: the `tripped → revisiting`
 * CAS has a single winner, a per-decision lock serialises tripwires of the same decision, one open revisit per
 * decision, and the unique issue key. Failures before the issue exists roll the tripwire back to `tripped` so
 * the next evaluation retries (and the evaluator un-sticks a `revisiting` tripwire whose rollback failed).
 */
export async function openRevisit(tripwireId: string, deps: RevisitDeps): Promise<OpenRevisitResult> {
  const { repo } = deps;
  const ctx = await repo.getTripwireContext(tripwireId);
  if (!ctx) return { created: false, reason: 'not_found' };
  if (ctx.tripwire.status !== 'tripped') return { created: false, reason: 'not_tripped' };

  if (!(await repo.casTripwire(tripwireId, ['tripped'], { status: 'revisiting' }))) return { created: false, reason: 'concurrent' };
  const rollback = async (): Promise<void> => {
    try {
      await repo.casTripwire(tripwireId, ['revisiting'], { status: 'tripped' });
    } catch (err) {
      console.error('tripwire revisit: rollback to tripped failed', { tripwireId, error: errorMessage(err) });
    }
  };

  const { decision } = ctx;
  let locked: boolean;
  try {
    locked = await repo.acquirePageLock(decision.pageId, 'revisit', deps.now().toISOString(), REVISIT_LOCK_SECONDS);
  } catch (err) {
    await rollback();
    throw err;
  }
  if (!locked) {
    await rollback();
    return { created: false, reason: 'decision_locked' };
  }
  try {
    // Re-read under the lock: a demo reset (or anything else) may have removed or archived the tripwire meanwhile,
    // and nothing may be written for a decision that no longer exists.
    const fresh = await repo.getTripwireContext(tripwireId);
    if (!fresh) return { created: false, reason: 'not_found' };
    if (fresh.tripwire.status !== 'revisiting') return { created: false, reason: 'concurrent' };
    return await openLocked(fresh, deps, rollback);
  } catch (err) {
    await rollback();
    throw err;
  } finally {
    await repo.releasePageLock(decision.pageId, 'revisit').catch((err: unknown) => {
      console.warn('tripwire revisit: lock release failed', { tripwireId, error: errorMessage(err) });
    });
  }
}

// --- Reaffirm ---------------------------------------------------------------------------------------

/** Largest threshold Reaffirm accepts; counts beyond this are almost certainly a typo. */
export const MAX_THRESHOLD = 1_000_000;
const NOTE_MAX = 500;

export interface ReaffirmDeps {
  repo: Repo;
  jira: Pick<typeof jira, 'transitionToDone' | 'addComment'>;
  /** Whether the calling user may edit the decision page (runs as the user). */
  canEditPage: (pageId: string) => Promise<boolean>;
  /** Current version of a watched page, the new content_change baseline; falls back to the last reading. */
  pageVersion?: (pageId: string) => Promise<number>;
  now?: () => Date;
}

export interface ReaffirmInput {
  newThreshold?: unknown;
  note?: unknown;
}

export type ReaffirmResult =
  | { reaffirmed: true; issueKey: string; oldThreshold: number; newThreshold: number; status: 'active'; warnings: string[] }
  | { reaffirmed: true; issueKey: string; kind: NonNumericKind; summary: string; status: 'active'; warnings: string[] }
  | { error: string };

type NonNumericKind = 'date' | 'checkin' | 'content_change';

/** What Reaffirm writes for one tripwire kind; `summary` goes into the Jira comment and the panel. */
interface ReaffirmPlan {
  patch: TripwirePatch;
  summary: string;
  threshold?: { old: number; new: number };
}

/** Valid new threshold (finite number in [0, MAX_THRESHOLD]) or an error message. */
export function parseThreshold(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'New threshold must be a number.' };
  if (value < 0 || value > MAX_THRESHOLD) return { ok: false, error: `New threshold must be between 0 and ${MAX_THRESHOLD}.` };
  return { ok: true, value };
}

/** Suggested new threshold: 20% above the last reading, rounded up (at least last + 1). */
export function suggestThreshold(lastValue: number | null, current: number): number {
  if (lastValue === null || !Number.isFinite(lastValue)) return current;
  return Math.min(MAX_THRESHOLD, Math.max(Math.ceil(lastValue * 1.2), Math.floor(lastValue) + 1));
}

// Plain text only (no mention node): who reaffirmed is in the issue history and the revisit row.
function reaffirmComment(issueKey: string, summary: string, note: string): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(text(`Decision reaffirmed via Tripwire: ${summary}. The tripwire is active again; ${issueKey} is resolved.`)),
      ...(note ? [paragraph(text(`Note: ${note}`))] : []),
    ],
  };
}

/**
 * Per kind: numeric → new threshold; checkin → answered now ("Still true"); content_change → the current page
 * version becomes the baseline; date → marked handled (one-shot, stays safe). Every plan resets strikes and
 * clears `lastOutcome` so the UI stops showing "tripped".
 */
async function reaffirmPlan(ctx: TripwireContext, input: ReaffirmInput, deps: ReaffirmDeps): Promise<ReaffirmPlan | { error: string }> {
  const { tripwire, decision } = ctx;
  const base = { status: 'active' as const, strikes: 0, lastOutcome: null };
  switch (tripwire.kind) {
    case 'jql_threshold':
    case 'graph_relation': {
      const parsed = parseThreshold(input.newThreshold);
      if (!parsed.ok) return { error: parsed.error };
      const oldThreshold = (tripwire.spec as { value: number }).value;
      const spec = { ...tripwire.spec, value: parsed.value } as TripwireContext['tripwire']['spec'];
      // lastValue stays: it is still the latest reading.
      return {
        patch: { ...base, spec },
        summary: `threshold ${oldThreshold} → ${parsed.value}`,
        threshold: { old: oldThreshold, new: parsed.value },
      };
    }
    case 'checkin': {
      const now = (deps.now ?? (() => new Date()))();
      const periodDays = PERIOD_DAYS[(tripwire.spec as CheckinSpec).every] ?? PERIOD_DAYS.month;
      return {
        patch: { ...base, confirmedAt: now.toISOString(), lastValue: periodDays },
        summary: `the assumption is still true; the next check-in is due in ${periodDays} days`,
      };
    }
    case 'content_change': {
      let version: number | null = null;
      if (deps.pageVersion) {
        try {
          version = await deps.pageVersion(decision.pageId);
        } catch (err) {
          console.warn('tripwire reaffirm: page version read failed, using the last reading', { pageId: decision.pageId, error: errorMessage(err) });
        }
      }
      version ??= tripwire.lastValue ?? decision.pageVersion ?? null;
      if (version === null || !Number.isInteger(version)) return { error: 'Could not read the current page version; try again in a minute.' };
      return {
        patch: { ...base, baselineVersion: version, lastValue: version },
        summary: `the page edits up to version ${version} keep the decision valid; later edits trip the tripwire again`,
      };
    }
    case 'date': {
      const spec = tripwire.spec as DateSpec;
      return {
        patch: { ...base, spec: { ...spec, resolved: true } },
        summary: `the ${spec.date} milestone was handled; this one-shot date tripwire stays safe from now on`,
      };
    }
  }
}

const ALREADY_RESOLVED = 'already resolved';

/** Why a closed revisit cannot be reaffirmed again; always starts with "already resolved". */
function closedMessage(revisit: RevisitRow): string {
  if (revisit.outcome === 'reaffirm') {
    return revisit.newThreshold !== undefined && revisit.newThreshold !== null
      ? `${ALREADY_RESOLVED}: the decision was reaffirmed with threshold ${revisit.newThreshold}.`
      : `${ALREADY_RESOLVED}: the decision was reaffirmed.`;
  }
  if (revisit.outcome === 'supersede') return `${ALREADY_RESOLVED}: the decision was superseded.`;
  return `${ALREADY_RESOLVED}: this revisit was closed.`;
}

/**
 * Reaffirm from the Revisit issue panel: the decision stands. Numeric tripwires get a new threshold, the others
 * are reset per kind (see `reaffirmPlan`). Only people who can edit the decision page may reaffirm. The
 * `revisiting → active` CAS and the conditional revisit close each have a single winner, so double clicks
 * resolve once. The Jira transition and comment are best effort: a failure there is reported as a warning and
 * never undoes the SQL change.
 */
export async function reaffirmRevisit(issueKey: string, accountId: string, input: ReaffirmInput, deps: ReaffirmDeps): Promise<ReaffirmResult> {
  const { repo } = deps;
  const revisit = await repo.getRevisitByIssue(issueKey);
  const ctx = revisit?.tripwireId ? await repo.getTripwireContext(revisit.tripwireId) : undefined;
  if (!revisit || !ctx) return { error: 'This work item is not a Tripwire revisit task.' };
  if (revisit.status === 'closed') return { error: closedMessage(revisit) };

  const { tripwire, decision } = ctx;
  if (!(await deps.canEditPage(decision.pageId))) {
    return { error: 'Only people who can edit the decision page can reaffirm it.' };
  }
  if (!['revisiting', 'tripped', 'active', 'near'].includes(tripwire.status)) {
    return { error: `This tripwire is ${tripwire.status}; only a tripped tripwire under revisit can be reaffirmed.` };
  }
  const plan = await reaffirmPlan(ctx, input, deps);
  if ('error' in plan) return plan;
  const note = typeof input.note === 'string' ? cut(input.note.replace(/\s+/g, ' ').trim(), NOTE_MAX) : '';

  const { patch } = plan;
  const close = () =>
    repo.closeRevisit(revisit.id, { outcome: 'reaffirm', resolvedBy: accountId, ...(plan.threshold ? { newThreshold: plan.threshold.new } : {}) });
  const warnings: string[] = [];

  if (tripwire.status === 'revisiting' || tripwire.status === 'tripped') {
    if (!(await repo.casTripwire(tripwire.id, ['revisiting', 'tripped'], patch))) return { error: ALREADY_RESOLVED };
    // An active tripwire next to an open revisit would block every later Revisit: put the tripwire back.
    const rollback = () =>
      repo
        .casTripwire(tripwire.id, ['active'], {
          status: tripwire.status,
          strikes: tripwire.strikes,
          spec: tripwire.spec,
          lastOutcome: tripwire.lastOutcome,
          lastValue: tripwire.lastValue,
          confirmedAt: tripwire.confirmedAt,
          baselineVersion: tripwire.baselineVersion,
        })
        .catch((rollbackErr: unknown) => {
          console.error('tripwire reaffirm: rollback failed', { issueKey, error: errorMessage(rollbackErr) });
          return false;
        });
    let closed: boolean;
    try {
      closed = await close();
    } catch (err) {
      await rollback();
      throw err;
    }
    if (!closed) {
      await rollback();
      return { error: ALREADY_RESOLVED };
    }
  } else if (tripwire.status === 'active' || tripwire.status === 'near') {
    // Orphan: the revisit stayed open after an earlier rollback failed. Close it first (single winner), then apply
    // the threshold, so the decision is not left with an open revisit nobody can resolve.
    if (!(await close())) return { error: ALREADY_RESOLVED };
    if (!(await repo.casTripwire(tripwire.id, [tripwire.status], patch))) {
      warnings.push(
        plan.threshold
          ? 'The tripwire changed while reaffirming; the new threshold was not applied. Check it on the decision page.'
          : 'The tripwire changed while reaffirming; it was not reset. Check it on the decision page.',
      );
    }
  }

  try {
    const status = await deps.jira.transitionToDone(issueKey);
    if (!status) warnings.push(`${issueKey} has no transition to a Done status; resolve it in Jira.`);
  } catch (err) {
    console.warn('tripwire reaffirm: transition failed', { issueKey, error: errorMessage(err) });
    warnings.push(`Could not move ${issueKey} to Done: ${errorMessage(err)}`);
  }
  try {
    await deps.jira.addComment(issueKey, reaffirmComment(issueKey, plan.summary, note));
  } catch (err) {
    console.warn('tripwire reaffirm: comment failed', { issueKey, error: errorMessage(err) });
    warnings.push(`Could not comment on ${issueKey}: ${errorMessage(err)}`);
  }
  console.info('tripwire reaffirmed', {
    issueKey,
    tripwireId: tripwire.id,
    kind: tripwire.kind,
    ...(plan.threshold ? { oldThreshold: plan.threshold.old, newThreshold: plan.threshold.new } : {}),
    warnings: warnings.length,
  });
  if (plan.threshold) {
    return { reaffirmed: true, issueKey, oldThreshold: plan.threshold.old, newThreshold: plan.threshold.new, status: 'active', warnings };
  }
  return { reaffirmed: true, issueKey, kind: tripwire.kind as NonNumericKind, summary: plan.summary, status: 'active', warnings };
}

async function openLocked(ctx: TripwireContext, deps: RevisitDeps, rollback: () => Promise<void>): Promise<OpenRevisitResult> {
  const { repo } = deps;
  const { decision, assumption } = ctx;
  const tripwireId = ctx.tripwire.id;
  const existing = await repo.findOpenRevisit(decision.id);
  if (existing) {
    // One open Revisit per decision. Unless it is this tripwire's own, stay `tripped` (not `revisiting` on
    // someone else's issue): the next evaluation retries and opens our own once that Revisit is closed.
    if (existing.tripwireId !== undefined && existing.tripwireId !== tripwireId) await rollback();
    return { created: false, reason: 'already_open', issueKey: existing.issueKey };
  }

  const projectKey = (await repo.getSettings()).revisitProjectKey;
  if (!projectKey) {
    await rollback();
    console.warn('tripwire revisit: no Revisit project configured', { tripwireId });
    return { created: false, reason: 'no_project' };
  }

  try {
    const project = await deps.jira.getProject(projectKey);
    if (!project) throw new JiraUnavailableError(`Jira project ${projectKey} not found`);
  } catch (err) {
    await rollback();
    if (err instanceof JiraUnavailableError) return { created: false, reason: 'jira_unavailable', message: err.message };
    return { created: false, reason: 'jira_error', message: errorMessage(err) };
  }

  const evaluations = await repo.listEvaluations(tripwireId, 5);
  const pageUrl = deps.pageUrl ? await deps.pageUrl(decision.pageId).catch(() => undefined) : undefined;
  let issue: { key: string; url: string };
  try {
    issue = await deps.jira.createIssue({
      projectKey,
      summary: revisitSummary(decision),
      description: revisitDescription(ctx, evaluations, pageUrl),
      labels: REVISIT_LABELS,
      assigneeAccountId: decision.ownerAccountId,
    });
  } catch (err) {
    await rollback();
    const reason = err instanceof JiraUnavailableError ? 'jira_unavailable' : 'jira_error';
    if (!(err instanceof JiraError) && !(err instanceof JiraUnavailableError)) console.error('tripwire revisit: createIssue failed', err);
    return { created: false, reason, message: errorMessage(err) };
  }

  // The issue exists now: never roll back from here on, or the next evaluation would create a second one.
  const row = { id: randomUUID(), decisionId: decision.id, tripwireId, issueKey: issue.key, status: 'open' as const };
  try {
    await repo.insertRevisit(row);
  } catch (first) {
    try {
      await repo.insertRevisit(row);
    } catch (second) {
      console.error(`tripwire revisit orphan issue=${issue.key}`, {
        tripwireId,
        decisionId: decision.id,
        errors: [errorMessage(first), errorMessage(second)],
      });
    }
  }
  try {
    await repo.insertRelation({ type: 'invalidated-by', fromId: assumption.id, toId: evaluations[0]?.id ?? issue.key });
  } catch (err) {
    console.warn('tripwire revisit: relation not saved', { tripwireId, issueKey: issue.key, error: errorMessage(err) });
  }
  console.info('tripwire revisit created', { tripwireId, issueKey: issue.key });
  return { created: true, issueKey: issue.key, url: issue.url };
}
