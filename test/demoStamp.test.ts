import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSummary } from '../src/adapters/confluence';
import type { ExtractDeps } from '../src/core/extractPipeline';
import { contentChangeReading } from '../src/core/triggers/content_change';
import { fakeRepo, type FakeRepo } from './helpers/fakeRepo';
import { seedTripwire } from './helpers/seed';

vi.mock('@forge/llm', () => ({ chat: vi.fn(), ForgeLlmError: class ForgeLlmError extends Error {} }));
vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

const { extractPage } = await import('../src/core/extractPipeline');
const { hasReviewStamp, reviewStamp, stampDemoReviews, STAMP_VERSION_MESSAGE } = await import('../src/surfaces/demoStamp');
type DemoStampDeps = import('../src/surfaces/demoStamp').DemoStampDeps;

type Page = { title: string; version: number; body: string };

const BODY = '<h1>Defer CSV export</h1><p>We decided to defer CSV export to next year.</p>';

let repo: FakeRepo;
let pages: Map<string, Page>;
let editable: Set<string>;
let deps: DemoStampDeps;
const updatePage = vi.fn<DemoStampDeps['updatePage']>();

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  repo = fakeRepo();
  pages = new Map([
    ['501', { title: 'Defer CSV export', version: 3, body: BODY }],
    ['502', { title: 'Go for services', version: 1, body: '<p>Go</p>' }],
  ]);
  editable = new Set(['501', '502']);
  // Like Confluence: the new version must be the current one + 1.
  updatePage.mockReset().mockImplementation(async (pageId, page) => {
    const current = pages.get(pageId)!;
    if (page.version !== current.version + 1) throw new Error('Confluence update page failed: 409 version conflict');
    pages.set(pageId, { title: page.title, version: page.version, body: page.body });
    return page.version;
  });
  deps = {
    repo,
    canEdit: async (pageId) => editable.has(pageId),
    getPage: async (pageId) => structuredClone(pages.get(pageId)),
    updatePage,
    now: () => Date.parse('2026-11-02T09:00:00Z'),
  };
});

/** Decision of page `pageId`, extracted at `version`, with a confirmed content_change tripwire with that baseline. */
function extracted(pageId: string, version: number): { decisionId: string; tripwireId: string } {
  const { decisionId, tripwireId } = seedTripwire(repo);
  const d = repo.decisions.get(decisionId)!;
  repo.decisions.set(decisionId, { ...d, pageId, pageVersion: version, extractedAt: '2026-11-02T08:00:00.000Z' });
  const t = repo.tripwires.get(tripwireId)!;
  repo.tripwires.set(tripwireId, { ...t, kind: 'content_change', spec: { pageId, watch: 'any_edit' }, baselineVersion: version });
  return { decisionId, tripwireId };
}

describe('stampDemoReviews', () => {
  it('appends "Reviewed by" (a mention of the admin) as a new version, once', async () => {
    expect(await stampDemoReviews(['501', '502'], 'admin-1', deps)).toEqual({ stamped: 2, skipped: 0, failed: 0, pending: 0, graphCachesCleared: 0 });
    const page = pages.get('501')!;
    expect(page.version).toBe(4);
    expect(page.body).toBe(`${BODY}<p>Reviewed by <ac:link><ri:user ri:account-id="admin-1" /></ac:link>.</p>`);
    expect(updatePage).toHaveBeenCalledWith('501', expect.objectContaining({ message: STAMP_VERSION_MESSAGE, version: 4 }));

    expect(await stampDemoReviews(['501', '502'], 'admin-2', deps)).toMatchObject({ stamped: 0, skipped: 2, failed: 0 });
    expect(updatePage).toHaveBeenCalledTimes(2);
    expect(pages.get('501')!.version).toBe(4);
    // The extract lock is free again.
    expect(repo.pageLocks.get('501')?.extract).toBeUndefined();
  });

  it('detects the note however Confluence re-serialises it', () => {
    expect(hasReviewStamp('<p local-id="x">Reviewed by <ac:link><ri:user ri:account-id="a" ri:local-id="y"/></ac:link>.</p>')).toBe(true);
    expect(hasReviewStamp(reviewStamp('bad id!'))).toBe(true);
    expect(reviewStamp('bad id!')).toBe('<p>Reviewed by the demo admin.</p>');
    expect(hasReviewStamp('<p><em>Reviewed 2026-11-02 (demo edit by Tripwire "Simulate a busy month").</em></p>')).toBe(false);
  });

  it('skips pages the admin cannot edit or see, without touching them', async () => {
    editable.delete('502');
    const getPage = vi.fn(deps.getPage);
    expect(await stampDemoReviews(['501', '502'], 'admin-1', { ...deps, getPage })).toMatchObject({ stamped: 1, skipped: 1 });
    expect(getPage).not.toHaveBeenCalledWith('502');
    expect(pages.get('502')!.version).toBe(1);
    expect(repo.pageLocks.get('502')).toBeUndefined();

    pages.delete('501');
    editable.add('501');
    pages.set('501', { title: 'x', version: 1, body: '<p>x</p>' });
    expect(await stampDemoReviews(['501'], 'admin-1', { ...deps, getPage: async () => undefined })).toMatchObject({ stamped: 0, skipped: 1 });
  });

  it('leaves a page being extracted for a later try (pending)', async () => {
    await repo.acquirePageLock('501', 'extract', '2026-11-02T08:59:00.000Z', 900);
    expect(await stampDemoReviews(['501', '502'], 'admin-1', deps)).toMatchObject({ stamped: 1, pending: 1 });
    expect(pages.get('501')!.version).toBe(3);
  });

  it('clears the not-ok graph caches of the stamped pages, keeping ok ones', async () => {
    const a = extracted('501', 3);
    const b = extracted('502', 1);
    const c = seedTripwire(repo);
    const sorted = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];
    for (const [x, y] of [sorted(a.decisionId, b.decisionId), sorted(a.decisionId, c.decisionId), sorted(b.decisionId, c.decisionId)]) {
      await repo.upsertRadarPair({ decisionAId: x, decisionBId: y, hashA: '1', hashB: '2', status: 'open', confidence: 0.9, summary: 's', sharedTopics: [] });
    }
    const ids = [...repo.radarPairs.keys()];
    const ok = { state: 'ok' as const, sharedContributors: 0, contributorsA: 1, contributorsB: 1, teamsA: [], teamsB: [], sharedTeam: null };
    await repo.updateRadarPairGraph(ids[0]!, { state: 'unavailable', reason: 'not_indexed' }, '2026-11-02T08:30:00.000Z');
    await repo.updateRadarPairGraph(ids[1]!, ok, '2026-11-02T08:30:00.000Z');
    await repo.updateRadarPairGraph(ids[2]!, { state: 'unavailable', reason: 'not_indexed' }, '2026-11-02T08:30:00.000Z');

    editable.delete('502');
    const result = await stampDemoReviews(['501', '502'], 'admin-1', deps);
    expect(result).toMatchObject({ stamped: 1, skipped: 1, graphCachesCleared: 1 });
    expect(repo.radarPairs.get(ids[0]!)).toMatchObject({ graph: null, graphFetchedAt: null });
    expect(repo.radarPairs.get(ids[1]!)?.graph).toEqual(ok);
    // Pair of page 502 and another page: 502 was not stamped, its cache stays.
    expect(repo.radarPairs.get(ids[2]!)?.graph).toEqual({ state: 'unavailable', reason: 'not_indexed' });

    // Already noted (e.g. by an earlier Load): the cache is still cleared.
    await repo.updateRadarPairGraph(ids[0]!, { state: 'unavailable', reason: 'not_indexed' }, '2026-11-02T08:50:00.000Z');
    expect(await stampDemoReviews(['501'], 'admin-1', deps)).toMatchObject({ skipped: 1, graphCachesCleared: 1 });
    expect(repo.radarPairs.get(ids[0]!)?.graph).toBeNull();
  });

  it('the stamp edit neither re-extracts the page nor trips its content_change tripwire', async () => {
    const { tripwireId } = extracted('501', 3);
    await stampDemoReviews(['501'], 'admin-1', deps);
    expect((await repo.getDecisionByPage('501'))?.pageVersion).toBe(4);
    const tripwire = repo.tripwires.get(tripwireId)!;
    expect(tripwire.baselineVersion).toBe(4);
    expect(contentChangeReading(pages.get('501')!.version, tripwire.baselineVersion ?? undefined).outcome).toBe('safe');

    // The page event's extraction, as the `extract` consumer runs it.
    const runExtraction = vi.fn<ExtractDeps['runExtraction']>();
    const page = (): PageSummary => ({ id: '501', spaceId: '1', ...pages.get('501')! });
    const extractDeps: ExtractDeps = {
      repo,
      confluence: { getPage: async () => page() },
      jira: { parseJql: vi.fn(), countIssues: vi.fn() },
      runExtraction,
      repairAssumption: vi.fn(),
      now: () => new Date('2026-11-02T09:01:00Z'),
    };
    expect(await extractPage({ pageId: '501' }, extractDeps)).toEqual({ status: 'skipped', reason: 'same_version' });
    expect(runExtraction).not.toHaveBeenCalled();
  });

  it('a real edit after the stamp still trips content_change', async () => {
    const { tripwireId } = extracted('501', 3);
    await stampDemoReviews(['501'], 'admin-1', deps);
    const baseline = repo.tripwires.get(tripwireId)!.baselineVersion ?? undefined;
    expect(contentChangeReading(5, baseline).outcome).toBe('tripped');
  });

  it('a failed edit puts the version and baseline back and does not stop the other pages', async () => {
    const { tripwireId } = extracted('501', 3);
    const update = deps.updatePage;
    const failing: DemoStampDeps['updatePage'] = async (pageId, page) => {
      if (pageId === '501') throw new Error('Confluence update page 501 as user failed: 403');
      return update(pageId, page);
    };
    expect(await stampDemoReviews(['501', '502'], 'admin-1', { ...deps, updatePage: failing })).toMatchObject({ stamped: 1, failed: 1 });
    expect((await repo.getDecisionByPage('501'))?.pageVersion).toBe(3);
    expect(repo.tripwires.get(tripwireId)?.baselineVersion).toBe(3);
    expect(repo.pageLocks.get('501')?.extract).toBeUndefined();
  });

  it('stops starting pages when the time budget is used up', async () => {
    let t = Date.parse('2026-11-02T09:00:00Z');
    const result = await stampDemoReviews(['501', '502'], 'admin-1', {
      ...deps,
      now: () => {
        t += 20_000;
        return t;
      },
    });
    expect(result).toMatchObject({ pending: 2, stamped: 0 });
  });

  it('does not start a page when less than one page of time is left', async () => {
    let t = Date.parse('2026-11-02T09:00:00Z');
    const ids = ['501', '502', '503', '504', '505'];
    for (const id of ids.slice(2)) pages.set(id, { title: id, version: 1, body: '<p>x</p>' });
    for (const id of ids) editable.add(id);
    const getPage = async (pageId: string) => {
      // Each page takes long: after the first four (run together) less than STAMP_PAGE_MS of the budget is left.
      t += 13_000;
      return structuredClone(pages.get(pageId));
    };
    const result = await stampDemoReviews(ids, 'admin-1', { ...deps, now: () => t, getPage });
    expect(result).toMatchObject({ stamped: 4, pending: 1 });
    expect(pages.get('505')!.version).toBe(1);
  });

  it('never writes when the storage body is missing or empty', async () => {
    const missing = await stampDemoReviews(['501'], 'admin-1', {
      ...deps,
      getPage: async () => {
        throw new Error('Confluence get page 501 as user returned no storage body');
      },
    });
    expect(missing).toMatchObject({ failed: 1, stamped: 0 });
    pages.set('502', { title: 'Go for services', version: 1, body: '  ' });
    expect(await stampDemoReviews(['502'], 'admin-1', deps)).toMatchObject({ failed: 1, stamped: 0 });
    expect(updatePage).not.toHaveBeenCalled();
    expect(repo.pageLocks.get('502')?.extract).toBeUndefined();
  });

  it('a write that errored but went through is kept (no undo)', async () => {
    const { tripwireId } = extracted('501', 3);
    const update = deps.updatePage;
    const timeout: DemoStampDeps['updatePage'] = async (pageId, page) => {
      await update(pageId, page);
      throw new Error('Confluence update page 501 as user failed: timeout');
    };
    expect(await stampDemoReviews(['501'], 'admin-1', { ...deps, updatePage: timeout })).toMatchObject({ stamped: 1, failed: 0 });
    expect(pages.get('501')!.version).toBe(4);
    expect((await repo.getDecisionByPage('501'))?.pageVersion).toBe(4);
    expect(repo.tripwires.get(tripwireId)?.baselineVersion).toBe(4);
  });

  it('the undo leaves a baseline someone else changed meanwhile', async () => {
    const { tripwireId } = extracted('501', 3);
    const failing: DemoStampDeps['updatePage'] = async () => {
      // E.g. "Accept page changes" while the write was under way.
      const t = repo.tripwires.get(tripwireId)!;
      repo.tripwires.set(tripwireId, { ...t, baselineVersion: 7 });
      throw new Error('Confluence update page 501 as user failed: 403');
    };
    expect(await stampDemoReviews(['501'], 'admin-1', { ...deps, updatePage: failing })).toMatchObject({ failed: 1 });
    expect(repo.tripwires.get(tripwireId)?.baselineVersion).toBe(7);
    expect((await repo.getDecisionByPage('501'))?.pageVersion).toBe(3);
  });

  it('follows the version Confluence actually saved', async () => {
    const { tripwireId } = extracted('501', 3);
    const update = deps.updatePage;
    const skipping: DemoStampDeps['updatePage'] = async (pageId, page) => (await update(pageId, page)) + 1;
    expect(await stampDemoReviews(['501'], 'admin-1', { ...deps, updatePage: skipping })).toMatchObject({ stamped: 1 });
    expect((await repo.getDecisionByPage('501'))?.pageVersion).toBe(5);
    expect(repo.tripwires.get(tripwireId)?.baselineVersion).toBe(5);
  });

  it('detects the note with NBSP, wrapping spans and card mentions', () => {
    expect(hasReviewStamp('<p>Reviewed&nbsp;by <ac:link><ri:user ri:account-id="a" /></ac:link>.</p>')).toBe(true);
    expect(hasReviewStamp('<p>Reviewed&#160;by&#xA0;<ac:link><ri:user ri:account-id="a" /></ac:link>.</p>')).toBe(true);
    expect(hasReviewStamp('<p><span style="x">Reviewed by</span> <ac:link ac:card-appearance="inline"><ri:user ri:account-id="a"/></ac:link>.</p>')).toBe(true);
    expect(hasReviewStamp('<p>Reviewed by the&nbsp;demo admin.</p>')).toBe(true);
    expect(hasReviewStamp('<p>Reviewed by</p><p><ac:link><ri:user ri:account-id="a" /></ac:link></p>')).toBe(false);
  });

  it('frees only its own, unexpired lock', async () => {
    // Took longer than the lock: an extraction may hold the page now.
    let t = Date.parse('2026-11-02T09:00:00Z');
    const slow = { ...deps, now: () => t, getPage: async (pageId: string) => structuredClone(pages.get(pageId)) };
    const update = deps.updatePage;
    const late: DemoStampDeps['updatePage'] = async (pageId, page) => {
      t += 121_000;
      await repo.acquirePageLock(pageId, 'extract', new Date(t).toISOString(), 900);
      return update(pageId, page);
    };
    await stampDemoReviews(['501'], 'admin-1', { ...slow, updatePage: late });
    expect(repo.pageLocks.get('501')?.extract).toBeDefined();

    // Same page lock column, another holder: not cleared.
    await repo.acquirePageLock('502', 'extract', '2026-11-02T08:00:00.000Z', 60);
    await repo.releasePageLock('502', 'extract', '2026-11-02T09:00:00.000Z');
    expect(repo.pageLocks.get('502')?.extract).toBeDefined();
  });
});
