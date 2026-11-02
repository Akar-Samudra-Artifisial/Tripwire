import { randomUUID } from 'node:crypto';
import { JiraError, JiraUnavailableError, type AdfDoc, type jira } from '../adapters/jira';
import type { DecisionRow, EvaluationRow, Repo, TripwireContext } from '../adapters/repo';
import { describeSpec, formatReading } from './describe';

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

/** Description of the Revisit work item: decision, assumption, tripwire, evidence and next step. */
export function revisitDescription(ctx: TripwireContext, evaluations: readonly EvaluationRow[], pageUrl?: string): AdfDoc {
  const { decision, assumption, tripwire } = ctx;
  const statement = decision.statement || decision.title || 'Untitled decision';
  const decisionParagraph = pageUrl
    ? paragraph(text(statement), text(' — '), text('open decision page', [{ type: 'link', attrs: { href: pageUrl } }]))
    : paragraph(text(statement));
  const held = Math.max(trippedRun(evaluations), tripwire.strikes);
  const history = evaluations.slice(0, 5).map((e) => `${e.evaluatedAt.slice(0, 10)} · ${e.value ?? '—'} · ${e.outcome}`);
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
      paragraph(
        text('Open the Decision revisit panel on this work item to reaffirm with a new threshold or supersede the decision.'),
      ),
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
    return await openLocked(ctx, deps, rollback);
  } catch (err) {
    await rollback();
    throw err;
  } finally {
    await repo.releasePageLock(decision.pageId, 'revisit').catch((err: unknown) => {
      console.warn('tripwire revisit: lock release failed', { tripwireId, error: errorMessage(err) });
    });
  }
}

async function openLocked(ctx: TripwireContext, deps: RevisitDeps, rollback: () => Promise<void>): Promise<OpenRevisitResult> {
  const { repo } = deps;
  const { decision, assumption } = ctx;
  const tripwireId = ctx.tripwire.id;
  const existing = await repo.findOpenRevisit(decision.id);
  if (existing) {
    await repo.insertRelation({ type: 'invalidated-by', fromId: assumption.id, toId: existing.issueKey });
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
