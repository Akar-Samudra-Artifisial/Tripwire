import type { Repo } from '../adapters/repo';
import { rememberedVersion, STAMP_LOCK_SECONDS } from '../core/pageVersion';

/**
 * "Reviewed by <admin>." note added to the demo pages after "Load demo data", as the admin who clicked. The pages
 * are created as the app, which Teamwork Graph does not count as a contributor; one human edit gives the Radar's
 * graph context a contributor on every demo page. Runs in a resolver: only there can Tripwire act as the user.
 */

/** Pages stamped at the same time. */
export const STAMP_CONCURRENCY = 4;
/** Everything must end within this long (the resolver limit is 25 s; schema and job checks run before). */
export const STAMP_BUDGET_MS = 18_000;
/** Time one page may take (access check, lock, read, write, re-read on failure, cache clear). */
export const STAMP_PAGE_MS = 6_000;
export const STAMP_VERSION_MESSAGE = 'Demo review note added by Tripwire "Load demo data"';

const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
/** Any space Confluence may write between words: whitespace, NBSP (raw or as an entity). */
const SP = String.raw`(?:\s|&nbsp;|&#160;|&#x[aA]0;| )`;
/** Inline markup Confluence may wrap the text in (not a paragraph and not the mentioned user). */
const INLINE = String.raw`<(?!\/?p\b|ri:user\b)[^>]*>`;
/**
 * A paragraph starting "Reviewed by" followed by a user mention (or the fallback text), however Confluence
 * re-serialises it (attributes, NBSP, `<ac:link>` with card attributes, wrapping spans).
 */
const STAMP_MARKER = new RegExp(
  String.raw`<p\b[^>]*>(?:${SP}|${INLINE})*Reviewed${SP}+by(?:${SP}|${INLINE})*(?:<ri:user\b|the${SP}+demo${SP}+admin\b)`,
  'i',
);

/** The note in storage format: a user mention renders as the admin's display name (no user-read scope needed). */
export function reviewStamp(accountId: string): string {
  return ACCOUNT_ID.test(accountId)
    ? `<p>Reviewed by <ac:link><ri:user ri:account-id="${accountId}" /></ac:link>.</p>`
    : '<p>Reviewed by the demo admin.</p>';
}

export const hasReviewStamp = (storage: string): boolean => STAMP_MARKER.test(storage);

export interface DemoStampDeps {
  repo: Pick<
    Repo,
    'acquirePageLock' | 'releasePageLock' | 'getDecisionByPage' | 'listTripwires' | 'casTripwire' | 'setDecisionPageVersion' | 'clearRadarGraphCache'
  >;
  /** As the user. */
  canEdit: (pageId: string) => Promise<boolean>;
  /** As the user; undefined when they cannot see the page; throws when the storage body is missing. */
  getPage: (pageId: string) => Promise<{ title: string; version: number; body: string } | undefined>;
  /** As the user; returns the saved version. */
  updatePage: (pageId: string, page: { title: string; body: string; version: number; message: string }) => Promise<number>;
  now: () => number;
}

export interface StampResult {
  /** Pages that got the note now. */
  stamped: number;
  /** Pages that already had it, or the user cannot edit. */
  skipped: number;
  failed: number;
  /** Pages being extracted right now, or not reached in time: call again later. */
  pending: number;
  /** Radar graph caches (not `ok`) cleared, so the next Radar view asks Teamwork Graph again. */
  graphCachesCleared: number;
}

type Outcome = { kind: 'stamped' | 'skipped' | 'failed' | 'pending'; cleared: number };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function clearGraphs(pageId: string, deps: DemoStampDeps): Promise<number> {
  const decision = await deps.repo.getDecisionByPage(pageId);
  return decision ? deps.repo.clearRadarGraphCache(decision.id) : 0;
}

/** After a failed write: the version the note is on when the write went through anyway (e.g. a timeout), else undefined. */
async function savedDespiteError(pageId: string, version: number, deps: DemoStampDeps): Promise<number | undefined> {
  try {
    const again = await deps.getPage(pageId);
    return again && again.version > version && hasReviewStamp(again.body) ? again.version : undefined;
  } catch (err) {
    console.warn('tripwire demo stamp: could not re-read page after a failed write', { pageId, error: errorMessage(err) });
    return undefined;
  }
}

async function stampPage(pageId: string, accountId: string, deps: DemoStampDeps): Promise<Outcome> {
  if (!(await deps.canEdit(pageId))) return { kind: 'skipped', cleared: 0 };
  // An extraction holds this lock while it reads the page and saves the version it read.
  const lockedAt = deps.now();
  const heldUntil = new Date(lockedAt + STAMP_LOCK_SECONDS * 1000).toISOString();
  if (!(await deps.repo.acquirePageLock(pageId, 'extract', new Date(lockedAt).toISOString(), STAMP_LOCK_SECONDS))) {
    return { kind: 'pending', cleared: 0 };
  }
  try {
    const page = await deps.getPage(pageId);
    if (!page) return { kind: 'skipped', cleared: 0 };
    if (hasReviewStamp(page.body)) return { kind: 'skipped', cleared: await clearGraphs(pageId, deps) };
    if (page.body.trim() === '') throw new Error(`Page ${pageId} has an empty storage body; not writing the note over it`);
    const remembered = await rememberedVersion(pageId, page.version, deps);
    const next = page.version + 1;
    await remembered.moveTo(next);
    let saved: number;
    try {
      saved = await deps.updatePage(pageId, { title: page.title, body: `${page.body}${reviewStamp(accountId)}`, version: next, message: STAMP_VERSION_MESSAGE });
    } catch (err) {
      const actual = await savedDespiteError(pageId, page.version, deps);
      if (actual === undefined) {
        await remembered.moveTo(page.version);
        throw err;
      }
      console.warn('tripwire demo stamp: write reported an error but the note is on the page', { pageId, version: actual, error: errorMessage(err) });
      saved = actual;
    }
    // Confluence numbers the version itself; follow it when it differs from the one asked for.
    if (saved !== next) await remembered.moveTo(saved);
    return { kind: 'stamped', cleared: await clearGraphs(pageId, deps) };
  } finally {
    // An expired lock may belong to an extraction by now: leave it (and only free our own).
    if (deps.now() < Date.parse(heldUntil)) {
      await deps.repo.releasePageLock(pageId, 'extract', heldUntil).catch((err: unknown) => {
        console.warn('tripwire demo stamp: lock release failed', { pageId, error: errorMessage(err) });
      });
    }
  }
}

/**
 * Adds the "Reviewed by" note to every demo page the user can edit and does not have it yet (idempotent: the note
 * is detected in the page body). A failure on one page never stops the others. A page is only started while one
 * page's worth of time is left in the budget; the rest is reported as pending.
 */
export async function stampDemoReviews(pageIds: readonly string[], accountId: string, deps: DemoStampDeps): Promise<StampResult> {
  const lastStart = deps.now() + STAMP_BUDGET_MS - STAMP_PAGE_MS;
  const todo = [...pageIds];
  const result: StampResult = { stamped: 0, skipped: 0, failed: 0, pending: 0, graphCachesCleared: 0 };
  const worker = async (): Promise<void> => {
    for (let pageId = todo.shift(); pageId !== undefined; pageId = todo.shift()) {
      if (deps.now() > lastStart) {
        result.pending += 1;
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await stampPage(pageId, accountId, deps);
      } catch (err) {
        console.warn('tripwire demo stamp: page not stamped', { pageId, error: errorMessage(err) });
        outcome = { kind: 'failed', cleared: 0 };
      }
      result[outcome.kind] += 1;
      result.graphCachesCleared += outcome.cleared;
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAMP_CONCURRENCY, todo.length) }, worker));
  return result;
}
