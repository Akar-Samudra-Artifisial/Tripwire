import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalOutcome } from '../src/core/evaluator';
import { fakeRepo, type FakeRepo } from './helpers/fakeRepo';
import { seedTripwire } from './helpers/seed';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

const { BUSY_MESSAGE, DEMO, DEMO_JQL, DEMO_STATE_KEY, demoSettings, LOAD_LOCK, loadDemoData, SeedError, SIMULATE_LOCK, simulateBusyMonth, TIME_BUDGET_MS } =
  await import('../src/adapters/seed');
const { SettingsError } = await import('../src/core/settings');
type SeedDeps = import('../src/adapters/seed').SeedDeps;

const ACCOUNT = '5b10ac8d82e05b22cc7d4ef5';

interface World {
  project: boolean;
  tickets: number;
  space?: { id: string; key: string };
  page?: { id: string; webUrl?: string };
  labels: string[];
}

function makeDeps(world: World, repo: FakeRepo, evaluate?: SeedDeps['evaluate']) {
  let clock = Date.parse('2026-11-02T10:00:00Z');
  const jira = {
    getProject: vi.fn(async (key: string) => (world.project ? { id: '10000', key, name: DEMO.projectName } : undefined)),
    createProject: vi.fn(async (input: { key: string }) => {
      world.project = true;
      return { id: '10000', key: input.key };
    }),
    countIssues: vi.fn(async () => world.tickets),
    bulkCreateIssues: vi.fn(async (_key: string, issues: readonly unknown[]) => {
      const keys = issues.map((_, i) => `SUP-${world.tickets + i + 1}`);
      world.tickets += issues.length;
      return keys;
    }),
  };
  const confluence = {
    findSpace: vi.fn(async () => world.space),
    createSpace: vi.fn(async (key: string) => (world.space = { id: '65537', key })),
    findPageByTitle: vi.fn(async () => world.page),
    createPage: vi.fn(async () => (world.page = { id: '123', webUrl: 'https://site/wiki/spaces/DEC/pages/123' })),
    getPageLabels: vi.fn(async () => [...world.labels]),
    addPageLabel: vi.fn(async (_id: string, label: string) => {
      world.labels.push(label);
    }),
    canEditPage: vi.fn(async () => true),
  };
  const deps: SeedDeps = {
    jira,
    confluence,
    repo,
    enqueueExtraction: vi.fn(async () => 'job-1'),
    evaluate: evaluate ?? vi.fn(async () => ({ results: [], rateLimited: false })),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { deps, jira, confluence, advance };
}

/** Demo page with a confirmed tripwire, as after "Load demo data" + Accept. */
function demoTripwire(repo: FakeRepo, status: 'active' | 'proposed' = 'active') {
  const seeded = seedTripwire(repo, { status });
  const pageId = repo.decisions.get(seeded.decisionId)!.pageId;
  repo.appValues.set(DEMO_STATE_KEY, { pageId });
  return seeded;
}

let repo: FakeRepo;
beforeEach(() => {
  repo = fakeRepo();
});

describe('demoSettings', () => {
  it('fills the Revisit project only when empty and adds SUP once', () => {
    expect(demoSettings({ decisionLabel: 'decision', watchedSpaceKeys: [], allowedProjectKeys: [] })).toEqual({
      revisitProjectKey: 'SUP',
      decisionLabel: 'decision',
      watchedSpaceKeys: [],
      allowedProjectKeys: ['SUP'],
    });
    expect(
      demoSettings({ revisitProjectKey: 'OPS', decisionLabel: 'adr', watchedSpaceKeys: ['ENG'], allowedProjectKeys: ['SUP', 'OPS'] }),
    ).toEqual({ revisitProjectKey: 'OPS', decisionLabel: 'adr', watchedSpaceKeys: ['ENG', 'DEC'], allowedProjectKeys: ['SUP', 'OPS'] });
  });
});

describe('loadDemoData', () => {
  it('creates project, tickets, space, labelled page and settings on an empty site', async () => {
    const world: World = { project: false, tickets: 0, labels: [] };
    const { deps, jira, confluence } = makeDeps(world, repo);

    const result = await loadDemoData(ACCOUNT, deps);

    expect(jira.createProject).toHaveBeenCalledWith(expect.objectContaining({ key: 'SUP', leadAccountId: ACCOUNT }));
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]).toHaveLength(7);
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]?.[0]).toMatchObject({ labels: ['export'] });
    expect(confluence.createSpace).toHaveBeenCalledWith('DEC', 'Decisions', expect.any(String));
    expect(confluence.createPage).toHaveBeenCalledWith('65537', 'Defer CSV export', expect.stringContaining('Fewer than 10 customer requests for CSV export per month'));
    expect(confluence.addPageLabel).toHaveBeenCalledWith('123', 'decision');
    expect(deps.enqueueExtraction).toHaveBeenCalledWith('123', false, ACCOUNT);
    expect(repo.settings).toMatchObject({ revisitProjectKey: 'SUP', decisionLabel: 'decision', allowedProjectKeys: ['SUP'] });
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual({ pageId: '123' });
    expect(result).toMatchObject({
      projectKey: 'SUP',
      revisitProjectKey: 'SUP',
      issueCount: 7,
      pageId: '123',
      pageUrl: 'https://site/wiki/spaces/DEC/pages/123',
      canEdit: true,
      created: { project: true, issues: 7, space: true, page: true, label: true },
    });
  });

  it('is idempotent: existing project, space and labelled page are reused, settings kept, only missing tickets added', async () => {
    const world: World = { project: true, tickets: 4, space: { id: '65537', key: 'DEC' }, page: { id: '123' }, labels: ['adr'] };
    repo.settings = { decisionLabel: 'adr', watchedSpaceKeys: ['ENG'], allowedProjectKeys: ['OPS', 'SUP'], revisitProjectKey: 'OPS' };
    await repo.upsertDecision({ pageId: '123', statement: 'Defer CSV export', topics: [], status: 'active' });
    const { deps, jira, confluence, advance } = makeDeps(world, repo);

    const result = await loadDemoData(ACCOUNT, deps);

    expect(jira.createProject).not.toHaveBeenCalled();
    expect(confluence.createSpace).not.toHaveBeenCalled();
    expect(confluence.createPage).not.toHaveBeenCalled();
    expect(confluence.addPageLabel).not.toHaveBeenCalled();
    expect(deps.enqueueExtraction).not.toHaveBeenCalled();
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]).toHaveLength(3);
    expect(repo.settings).toEqual({ revisitProjectKey: 'OPS', decisionLabel: 'adr', watchedSpaceKeys: ['ENG', 'DEC'], allowedProjectKeys: ['OPS', 'SUP'] });
    expect(result.created).toEqual({ project: false, issues: 3, space: false, page: false, label: false });
    expect(result).toMatchObject({ issueCount: 7, revisitProjectKey: 'OPS' });

    // Clicking again after the cooldown creates nothing.
    advance(61_000);
    jira.bulkCreateIssues.mockClear();
    const again = await loadDemoData(ACCOUNT, deps);
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
    expect(again.created.issues).toBe(0);
  });

  it('refuses a second click while the first holds the lock (no duplicate tickets)', async () => {
    const world: World = { project: true, tickets: 0, space: { id: '1', key: 'DEC' }, page: { id: '55' }, labels: ['decision'] };
    const { deps, jira } = makeDeps(world, repo);
    const [first, second] = await Promise.allSettled([loadDemoData(ACCOUNT, deps), loadDemoData(ACCOUNT, deps)]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: new SeedError(BUSY_MESSAGE) });
    expect(jira.bulkCreateIssues).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when seeding fails', async () => {
    const world: World = { project: true, tickets: 0, labels: [] };
    const { deps, confluence } = makeDeps(world, repo);
    confluence.findSpace.mockRejectedValueOnce(new Error('Confluence 500'));
    await expect(loadDemoData(ACCOUNT, deps)).rejects.toThrow('Confluence 500');
    expect(repo.appLocks.has(LOAD_LOCK)).toBe(false);
  });

  it('validates the merged settings before creating anything', async () => {
    repo.settings = { decisionLabel: 'decision', watchedSpaceKeys: [], allowedProjectKeys: Array.from({ length: 20 }, (_, i) => `P${i}X`) };
    const { deps, jira, confluence } = makeDeps({ project: false, tickets: 0, labels: [] }, repo);
    await expect(loadDemoData(ACCOUNT, deps)).rejects.toBeInstanceOf(SettingsError);
    expect(jira.createProject).not.toHaveBeenCalled();
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
    expect(confluence.createSpace).not.toHaveBeenCalled();
  });

  it('labels an existing unlabelled page, queues extraction and reports when the caller cannot edit it', async () => {
    const world: World = { project: true, tickets: 7, space: { id: '1', key: 'DEC' }, page: { id: '55' }, labels: [] };
    const { deps, confluence } = makeDeps(world, repo);
    confluence.canEditPage.mockResolvedValueOnce(false);
    const result = await loadDemoData(ACCOUNT, deps);
    expect(confluence.addPageLabel).toHaveBeenCalledWith('55', 'decision');
    expect(deps.enqueueExtraction).toHaveBeenCalledWith('55', false, ACCOUNT);
    expect(result.canEdit).toBe(false);
  });

  it('rejects a malformed account id', async () => {
    const { deps } = makeDeps({ project: false, tickets: 0, labels: [] }, repo);
    await expect(loadDemoData('bad id; drop', deps)).rejects.toBeInstanceOf(SeedError);
  });
});

describe('simulateBusyMonth', () => {
  const tripping = (decisionId: string) => {
    let pass = 0;
    return vi.fn(async (ids: readonly string[]) => {
      pass += 1;
      if (pass === 2) await repo.insertRevisit({ id: 'rv-1', decisionId, issueKey: 'SUP-99', tripwireId: ids[0], status: 'open' });
      const results: EvalOutcome[] = ids.map((id) => ({
        status: 'evaluated',
        tripwireId: id,
        outcome: 'tripped',
        value: 37,
        newStatus: pass === 1 ? 'active' : 'tripped',
        revisitRequested: pass === 2,
      }));
      return { results, rateLimited: false };
    });
  };

  it('adds 30 export tickets and evaluates only the demo decision tripwires, twice', async () => {
    const { tripwireId, decisionId } = demoTripwire(repo);
    seedTripwire(repo, { status: 'active' }); // another team's decision: must not be evaluated
    const evaluate = tripping(decisionId);
    const { deps, jira } = makeDeps({ project: true, tickets: 7, labels: [] }, repo, evaluate);

    const result = await simulateBusyMonth(deps);

    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]).toHaveLength(30);
    expect(jira.countIssues).toHaveBeenCalledWith(DEMO_JQL);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenNthCalledWith(1, [tripwireId]);
    expect(evaluate).toHaveBeenNthCalledWith(2, [tripwireId]);
    expect(result).toMatchObject({ created: 30, issueCount: 37, indexed: true, complete: true, revisits: [{ tripwireId, issueKey: 'SUP-99' }] });
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 30 });
    expect(repo.appLocks.has(SIMULATE_LOCK)).toBe(false);
  });

  it('a second click reuses the tickets and only evaluates', async () => {
    const { decisionId } = demoTripwire(repo);
    const { deps, jira } = makeDeps({ project: true, tickets: 7, labels: [] }, repo, tripping(decisionId));
    await simulateBusyMonth(deps);
    jira.bulkCreateIssues.mockClear();
    const again = await simulateBusyMonth(deps);
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
    expect(again).toMatchObject({ created: 0, issueCount: 37, indexed: true });
    expect(again.passes).toHaveLength(2);
  });

  it('refuses a concurrent click', async () => {
    demoTripwire(repo);
    repo.appLocks.set(SIMULATE_LOCK, '2099-01-01T00:00:00.000Z');
    const { deps, jira } = makeDeps({ project: true, tickets: 7, labels: [] }, repo);
    await expect(simulateBusyMonth(deps)).rejects.toThrow(BUSY_MESSAGE);
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
  });

  it('does not evaluate while Jira search has not caught up, and says so', async () => {
    demoTripwire(repo);
    const { deps, jira } = makeDeps({ project: true, tickets: 7, labels: [] }, repo);
    jira.countIssues.mockResolvedValue(7);
    const result = await simulateBusyMonth(deps);
    expect(deps.sleep).toHaveBeenCalled();
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 30, indexed: false, complete: false, passes: [] });
  });

  it('stops before the second pass when the time budget is used up', async () => {
    const { decisionId } = demoTripwire(repo);
    const world: World = { project: true, tickets: 7, labels: [] };
    const made = makeDeps(world, repo);
    const evaluate = vi.fn(async (ids: readonly string[]) => {
      made.advance(TIME_BUDGET_MS);
      return tripping(decisionId)(ids);
    });
    made.deps.evaluate = evaluate;
    const result = await simulateBusyMonth(made.deps);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ complete: false });
  });

  it('refuses without a confirmed tripwire on the demo page and creates no tickets', async () => {
    demoTripwire(repo, 'proposed');
    seedTripwire(repo, { status: 'active' });
    const { deps, jira } = makeDeps({ project: true, tickets: 7, labels: [] }, repo);
    await expect(simulateBusyMonth(deps)).rejects.toThrow(/accept its tripwire/);
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
  });

  it('refuses before "Load demo data" ran', async () => {
    seedTripwire(repo, { status: 'active' });
    const { deps } = makeDeps({ project: true, tickets: 0, labels: [] }, repo);
    await expect(simulateBusyMonth(deps)).rejects.toThrow(/Load demo data/);
  });
});
