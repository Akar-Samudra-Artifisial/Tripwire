import { randomUUID } from 'node:crypto';
import type { confluence } from '../adapters/confluence';
import type { jira } from '../adapters/jira';
import type { Repo, TripwireRow } from '../adapters/repo';
import { isLlmRateLimited } from '../llm';
import type { repairAssumption, runExtraction } from '../llm/extract';
import { parseAssumption, parseExtraction, sameQuote, toCheckin, type DroppedItem, type ParsedAssumption } from './extraction';
import { storageToText } from './pageText';
import { thresholdOutcome } from './triggers/common';
import type { Assumption, JqlThresholdSpec } from './types';

export interface ExtractDeps {
  repo: Repo;
  confluence: Pick<typeof confluence, 'getPage'>;
  jira: Pick<typeof jira, 'parseJql' | 'countIssues'>;
  runExtraction: typeof runExtraction;
  repairAssumption: typeof repairAssumption;
  now: () => Date;
}

export interface ExtractRequest {
  pageId: string;
  /** Re-extract even when the page version is unchanged or tripwires were already confirmed. */
  force?: boolean;
  /** Account that pressed Scan; becomes the decision owner. */
  requestedBy?: string;
}

export type ExtractResult =
  | { status: 'skipped'; reason: 'same_version' | 'has_confirmed' | 'not_decision_page' | 'locked' }
  | { status: 'done'; decisionId: string; assumptions: number; dropped: number }
  | { status: 'error'; message: string };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Longer than one extraction can run (queue consumer timeout), so a crashed run frees the page by itself. */
export const EXTRACT_LOCK_SECONDS = 15 * 60;

/**
 * Extracts the decision and proposed tripwires for one page. Only `proposed` tripwires are replaced. Runs for
 * the same page are serialised by a page lock; a run that finds the lock taken returns `skipped: locked`.
 */
export async function extractPage(req: ExtractRequest, deps: ExtractDeps): Promise<ExtractResult> {
  const { repo } = deps;
  if (!(await repo.acquirePageLock(req.pageId, 'extract', deps.now().toISOString(), EXTRACT_LOCK_SECONDS))) {
    return { status: 'skipped', reason: 'locked' };
  }
  try {
    return await extractLocked(req, deps);
  } finally {
    await repo.releasePageLock(req.pageId, 'extract').catch((err: unknown) => {
      console.warn('tripwire extract: lock release failed', { pageId: req.pageId, error: errorMessage(err) });
    });
  }
}

async function extractLocked(req: ExtractRequest, deps: ExtractDeps): Promise<ExtractResult> {
  const { repo } = deps;
  try {
    const page = await deps.confluence.getPage(req.pageId, true);
    const existing = await repo.getDecisionByPage(req.pageId);
    if (!req.force && existing) {
      if (existing.pageVersion === page.version) return { status: 'skipped', reason: 'same_version' };
      if (await repo.hasConfirmedTripwires(existing.id)) return { status: 'skipped', reason: 'has_confirmed' };
    }

    const text = storageToText(page.body ?? '');
    if (text === '') throw new Error('empty page');

    const settings = await repo.getSettings();
    const now = deps.now();
    const ctx = {
      pageId: req.pageId,
      title: page.title,
      projectKeys: settings.allowedProjectKeys,
      today: now.toISOString().slice(0, 10),
    };
    const { raw } = await deps.runExtraction(text, ctx);
    const parsed = parseExtraction(raw, text, req.pageId, page.title, settings.allowedProjectKeys);
    const assumptions: ParsedAssumption[] = [...parsed.assumptions];
    const dropped: DroppedItem[] = [...parsed.dropped];

    for (const item of parsed.repairable) {
      let repaired: ReturnType<typeof parseAssumption> | undefined;
      try {
        repaired = parseAssumption(await deps.repairAssumption(item.item, item.errors, ctx), text, req.pageId, settings.allowedProjectKeys);
      } catch (err) {
        if (isLlmRateLimited(err)) throw err;
        dropped.push({ index: item.index, reason: `repair failed: ${errorMessage(err)}` });
      }
      if (repaired?.ok) assumptions.push(repaired.assumption);
      else assumptions.push({ ...item.item, kind: 'checkin', spec: toCheckin(item.item.summary) });
    }

    // A forced re-scan keeps confirmed tripwires; do not propose the same assumption a second time.
    const confirmedQuotes = existing ? await confirmedAssumptionQuotes(repo, existing.id) : [];
    const fresh = assumptions.filter((a) => {
      const duplicate = confirmedQuotes.some((q) => sameQuote(q, a.quote));
      if (duplicate) dropped.push({ index: -1, reason: 'already confirmed', item: a.quote });
      return !duplicate;
    });

    const nowIso = now.toISOString();
    const items: { assumption: Assumption; tripwire: TripwireRow }[] = [];
    for (const a of fresh) {
      const assumptionId = randomUUID();
      let kind = a.kind;
      let spec = a.spec;
      let lastValue: number | null = null;
      let lastOutcome: TripwireRow['lastOutcome'] = null;
      let lastEvaluatedAt: string | null = null;
      if (kind === 'jql_threshold') {
        const jqlSpec = spec as JqlThresholdSpec;
        const check = await deps.jira.parseJql(jqlSpec.jql).catch((err: unknown) => ({ ok: false as const, errors: [errorMessage(err)] }));
        if (!check.ok) {
          dropped.push({ index: -1, reason: `jql rejected: ${check.errors.join('; ')}`, item: jqlSpec.jql });
          kind = 'checkin';
          spec = toCheckin(a.summary);
        } else {
          try {
            lastValue = await deps.jira.countIssues(jqlSpec.jql);
            lastOutcome = thresholdOutcome(lastValue, jqlSpec.op, jqlSpec.value);
            lastEvaluatedAt = nowIso;
          } catch (err) {
            console.warn('tripwire extract: first count failed', { pageId: req.pageId, error: errorMessage(err) });
          }
        }
      }
      items.push({
        assumption: { id: assumptionId, decisionId: '', quote: a.quote, summary: a.summary },
        tripwire: {
          id: randomUUID(),
          assumptionId,
          kind,
          spec,
          status: 'proposed',
          strikes: 0,
          lastValue,
          lastOutcome,
          lastEvaluatedAt,
          baselineVersion: null,
        },
      });
    }

    const decision = await repo.upsertDecision({
      pageId: req.pageId,
      title: page.title,
      statement: parsed.decision.statement,
      ownerAccountId: req.requestedBy ?? existing?.ownerAccountId ?? page.authorId,
      team: parsed.decision.team,
      decidedAt: parsed.decision.decidedAt,
      topics: parsed.decision.topics,
      status: 'active',
      pageVersion: page.version,
      extractedAt: nowIso,
      extractError: undefined,
    });
    const owned = items.map((i) => ({ ...i, assumption: { ...i.assumption, decisionId: decision.id } }));
    await repo.replaceProposed(decision.id, owned);
    for (const i of owned) await repo.insertRelation({ type: 'rests-on', fromId: decision.id, toId: i.assumption.id });

    if (dropped.length > 0) console.info('tripwire extract dropped', { pageId: req.pageId, dropped: dropped.map((d) => d.reason) });
    return { status: 'done', decisionId: decision.id, assumptions: owned.length, dropped: dropped.length };
  } catch (err) {
    if (isLlmRateLimited(err)) throw err;
    const message = errorMessage(err).slice(0, 1000);
    await repo.markExtractError(req.pageId, message);
    return { status: 'error', message };
  }
}

async function confirmedAssumptionQuotes(repo: Repo, decisionId: string): Promise<string[]> {
  const [assumptions, tripwires] = await Promise.all([repo.listAssumptions(decisionId), repo.listTripwires(decisionId)]);
  const confirmed = new Set(tripwires.filter((t) => t.status !== 'proposed').map((t) => t.assumptionId));
  return assumptions.filter((a) => confirmed.has(a.id)).map((a) => a.quote);
}
