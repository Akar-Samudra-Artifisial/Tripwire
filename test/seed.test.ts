import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalOutcome } from '../src/core/evaluator';
import { fakeRepo, type FakeRepo } from './helpers/fakeRepo';
import { seedTripwire } from './helpers/seed';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

const {
  BUSY_MESSAGE,
  DEMO,
  DEMO_JQL,
  DEMO_STATE_KEY,
  demoSettings,
  INDEX_LAG_MESSAGE,
  LOAD_LOCK,
  loadDemoData,
  PAGE_BUSY_MESSAGE,
  resetDemo,
  SeedError,
  SIMULATE_LOCK,
  simulateBusyMonth,
  TIME_BUDGET_MS,
} = await import('../src/adapters/seed');
const { SettingsError } = await import('../src/core/settings');
type SeedDeps = import('../src/adapters/seed').SeedDeps;

const ACCOUNT = '5b10ac8d82e05b22cc7d4ef5';

interface World {
  project: boolean;
  tickets: number;
  space?: { id: string; key: string };
  page?: { id: string; webUrl?: string };
  labels: string[];
  /** Issues Jira search does not see yet (index lag). */
  hidden?: Set<string>;
  /** Extra tickets the approximate count still reports (index lag after relabelling). */
  countLag?: number;
}

function makeDeps(world: World, repo: FakeRepo, evaluate?: SeedDeps['evaluate']) {
  let clock = Date.parse('2026-11-02T10:00:00Z');
  // Every SUP issue; `world.tickets` stays the number labelled `export` (what the demo JQL counts).
  const issues: { key: string; summary: string; labels: string[] }[] = Array.from({ length: world.tickets }, (_, i) => ({
    key: `SUP-${i + 1}`,
    summary: `Baseline ticket ${i + 1}`,
    labels: ['export'],
  }));
  const jira = {
    getProject: vi.fn(async (key: string) => (world.project ? { id: '10000', key, name: DEMO.projectName } : undefined)),
    createProject: vi.fn(async (input: { key: string }) => {
      world.project = true;
      return { id: '10000', key: input.key };
    }),
    countIssues: vi.fn(async () => world.tickets + (world.countLag ?? 0)),
    bulkCreateIssues: vi.fn(async (_key: string, created: readonly { summary: string; labels: string[] }[]) => {
      const keys = created.map((n) => {
        const key = `SUP-${issues.length + 1}`;
        issues.push({ key, summary: n.summary, labels: [...n.labels] });
        return key;
      });
      world.tickets += created.length;
      return keys;
    }),
    searchIssues: vi.fn(async (jql: string, max: number) =>
      issues
        .filter((i) => !world.hidden?.has(i.key))
        .filter((i) => i.labels.includes('export') || (jql.includes('tripwire-demo-sim') && i.labels.includes('tripwire-demo-sim')))
        .slice(0, max)
        .map((i) => structuredClone(i)),
    ),
    updateLabels: vi.fn(async (key: string, add: readonly string[], remove: readonly string[]) => {
      const issue = issues.find((i) => i.key === key)!;
      const had = issue.labels.includes('export');
      issue.labels = [...issue.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !issue.labels.includes(l))];
      if (had && !issue.labels.includes('export')) world.tickets -= 1;
    }),
    transitionToDone: vi.fn(async (): Promise<string | undefined> => 'Done'),
    addComment: vi.fn(async () => undefined),
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
    updatePage: vi.fn(async () => 2),
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
  return { deps, jira, confluence, advance, issues };
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

  it('moves date/checkin a month on and edits the page for content_change before evaluating', async () => {
    const { decisionId, assumptionId } = demoTripwire(repo);
    const base = { assumptionId, status: 'active' as const, confirmedBy: 'owner-1', strikes: 0, lastValue: null, lastOutcome: null, lastEvaluatedAt: null };
    repo.tripwires.set('tw-date', { ...base, id: 'tw-date', kind: 'date', spec: { date: '2027-03-31', leadDays: 30 }, confirmedAt: '2026-10-01T00:00:00.000Z', baselineVersion: null });
    repo.tripwires.set('tw-done', { ...base, id: 'tw-done', kind: 'date', spec: { date: '2026-10-01', leadDays: 3, resolved: true }, baselineVersion: null });
    repo.tripwires.set('tw-check', { ...base, id: 'tw-check', kind: 'checkin', spec: { every: 'quarter', question: 'Still on PDF?' }, confirmedAt: '2026-11-01T00:00:00.000Z', baselineVersion: null });
    repo.tripwires.set('tw-page', { ...base, id: 'tw-page', kind: 'content_change', spec: { pageId: '1', watch: 'any_edit' }, baselineVersion: 1 });
    const { deps, confluence } = makeDeps({ project: true, tickets: 7, labels: [] }, repo, tripping(decisionId));

    await simulateBusyMonth(deps);

    expect(repo.tripwires.get('tw-date')?.spec).toEqual({ date: '2026-11-01', leadDays: 30 });
    expect(repo.tripwires.get('tw-done')?.spec).toEqual({ date: '2026-10-01', leadDays: 3, resolved: true });
    // quarter = 91 days, plus one: overdue by a day.
    expect(repo.tripwires.get('tw-check')?.confirmedAt).toBe(new Date(Date.parse('2026-11-02T10:00:00Z') - 92 * 86_400_000).toISOString());
    const pageId = repo.decisions.get(decisionId)!.pageId;
    expect(confluence.updatePage).toHaveBeenCalledTimes(1);
    expect(confluence.updatePage).toHaveBeenCalledWith(pageId, expect.stringContaining('Reviewed 2026-11-02'), expect.any(String));
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

describe('resetDemo', () => {
  /** Demo decision after Simulate: tripwire revisiting, 2 evaluations, an open Revisit, 30 busy month tickets. */
  async function simulatedWorld() {
    const { decisionId, tripwireId, assumptionId } = demoTripwire(repo);
    const other = seedTripwire(repo, { status: 'revisiting' }); // another decision: must survive the reset
    await repo.insertRevisit({ id: 'rv-other', decisionId: other.decisionId, issueKey: 'OPS-5', tripwireId: other.tripwireId, status: 'open' });
    const world: World = { project: true, tickets: 7, labels: [] };
    const made = makeDeps(world, repo, tripping(decisionId));
    await simulateBusyMonth(made.deps);
    await repo.insertRelation({ type: 'invalidated-by', fromId: assumptionId, toId: 'SUP-99' });
    await repo.insertEvaluation({ id: 'ev-other', tripwireId: other.tripwireId, value: 5, outcome: 'safe', evaluatedAt: '2026-11-01T00:00:00.000Z' });
    const pageId = repo.decisions.get(decisionId)!.pageId;
    return { ...made, world, decisionId, tripwireId, other, pageId };
  }

  const tripping = (decisionId: string) => {
    let pass = 0;
    return vi.fn(async (ids: readonly string[]) => {
      pass += 1;
      for (const id of ids) {
        await repo.insertEvaluation({ id: `ev-${id}-${pass}`, tripwireId: id, value: 37, outcome: 'tripped', evaluatedAt: `2026-11-0${pass}T00:00:00.000Z` });
        if (pass === 2) await repo.casTripwire(id, ['active'], { status: 'revisiting', strikes: 2 });
      }
      if (pass === 2) await repo.insertRevisit({ id: 'rv-1', decisionId, issueKey: 'SUP-99', tripwireId: ids[0], status: 'open' });
      const results: EvalOutcome[] = ids.map((id) => ({
        status: 'evaluated',
        tripwireId: id,
        outcome: 'tripped',
        value: 37,
        newStatus: pass === 1 ? 'near' : 'tripped',
        revisitRequested: pass === 2,
      }));
      return { results, rateLimited: false };
    });
  };

  it('isSimulatedTicket recognises the label or the exact generated summary only', async () => {
    const { isSimulatedTicket, SIM_LABEL } = await import('../src/adapters/seed');
    expect(isSimulatedTicket({ summary: 'anything', labels: ['export', SIM_LABEL] })).toBe(true);
    expect(isSimulatedTicket({ summary: 'CSV export needed for quarterly board pack (#1)', labels: ['export'] })).toBe(true);
    expect(isSimulatedTicket({ summary: 'Customer escalation: no way to export report data (#2)', labels: ['export'] })).toBe(true);
    // Wrong pairing of summary and number, out of range, or a baseline ticket: not a simulated ticket.
    expect(isSimulatedTicket({ summary: 'CSV export needed for quarterly board pack (#2)', labels: ['export'] })).toBe(false);
    expect(isSimulatedTicket({ summary: 'CSV export needed for quarterly board pack (#31)', labels: ['export'] })).toBe(false);
    expect(isSimulatedTicket({ summary: 'Need CSV export for finance reconciliation', labels: ['export'] })).toBe(false);
  });

  it('new busy month tickets carry the simulation label', async () => {
    demoTripwire(repo);
    const { deps, jira } = makeDeps({ project: true, tickets: 7, labels: [] }, repo);
    await simulateBusyMonth(deps);
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]?.[0]).toMatchObject({ labels: ['export', 'tripwire-demo-sim'] });
  });

  it('removes only demo data: busy month tickets, demo Revisit, demo decision rows and the simulate marker', async () => {
    const w = await simulatedWorld();
    // An unlabelled ticket from an old run (summary pattern) and a ticket a person added by hand.
    w.issues.push({ key: 'SUP-200', summary: 'Export dashboard widgets to CSV (#3)', labels: ['export'] });
    w.issues.push({ key: 'SUP-201', summary: 'Real customer: CSV please', labels: ['export'] });
    const cas = vi.spyOn(repo, 'casTripwire');
    const result = await resetDemo(ACCOUNT, w.deps);

    expect(w.jira.searchIssues).toHaveBeenCalledWith('project = SUP AND (labels = export OR labels = tripwire-demo-sim)', expect.any(Number));
    // Archived before the rows go, so an evaluation that read the tripwire earlier loses its CAS.
    expect(cas).toHaveBeenCalledWith(w.tripwireId, expect.arrayContaining(['revisiting', 'active']), { status: 'archived' });
    expect(result).toMatchObject({ relabelled: 31, remaining: 8, revisitIssueKey: 'SUP-99', complete: true, indexed: true, warnings: [] });
    expect(result.deleted).toEqual({ tripwires: 1, assumptions: 1, evaluations: 2, revisits: 1 });
    expect(w.issues.filter((i) => i.labels.includes('export')).map((i) => i.key)).toEqual([
      'SUP-1', 'SUP-2', 'SUP-3', 'SUP-4', 'SUP-5', 'SUP-6', 'SUP-7', 'SUP-201',
    ]);
    expect(w.jira.updateLabels).toHaveBeenCalledWith('SUP-200', ['tripwire-demo-sim'], ['export']);
    expect(w.jira.transitionToDone).toHaveBeenCalledTimes(1);
    expect(w.jira.transitionToDone).toHaveBeenCalledWith('SUP-99');
    expect(w.jira.addComment).toHaveBeenCalledWith('SUP-99', expect.anything());
    // Demo decision gone, the other decision untouched.
    expect(repo.decisions.has(w.decisionId)).toBe(false);
    expect(repo.tripwires.has(w.tripwireId)).toBe(false);
    expect(repo.relations).toHaveLength(0);
    expect(repo.tripwires.get(w.other.tripwireId)?.status).toBe('revisiting');
    expect(repo.revisits.get('rv-other')?.status).toBe('open');
    expect(repo.evaluations.map((e) => e.id)).toEqual(['ev-other']);
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual({ pageId: expect.any(String) });
    expect(w.deps.enqueueExtraction).toHaveBeenLastCalledWith(expect.any(String), true, ACCOUNT);
    expect(repo.appLocks.has(SIMULATE_LOCK)).toBe(false);
    expect(repo.appLocks.has(LOAD_LOCK)).toBe(false);
  });

  it('relabels remembered busy month tickets by key even when search does not see them yet', async () => {
    const w = await simulatedWorld();
    w.world.hidden = new Set(['SUP-8', 'SUP-9']);
    const result = await resetDemo(ACCOUNT, w.deps);
    expect(w.jira.updateLabels).toHaveBeenCalledWith('SUP-8', ['tripwire-demo-sim'], ['export']);
    expect(result).toMatchObject({ relabelled: 30, complete: true, indexed: true });
  });

  it('keeps the marker and the decision when search has not caught up with the busy month (no remembered keys)', async () => {
    const w = await simulatedWorld();
    // State written before Simulate remembered keys.
    repo.appValues.set(DEMO_STATE_KEY, { pageId: w.pageId, simulatedTickets: 30 });
    w.world.hidden = new Set(['SUP-30', 'SUP-31', 'SUP-32']);
    const result = await resetDemo(ACCOUNT, w.deps);
    expect(result).toMatchObject({ complete: false, indexed: false, deleted: null, message: INDEX_LAG_MESSAGE, relabelled: 27 });
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual({ pageId: w.pageId, simulatedTickets: 30 });
    expect(repo.decisions.has(w.decisionId)).toBe(true);
    expect(w.deps.enqueueExtraction).not.toHaveBeenCalledWith(w.pageId, true, ACCOUNT);
    // A minute later search sees them: the reset finishes.
    w.world.hidden = undefined;
    expect(await resetDemo(ACCOUNT, w.deps)).toMatchObject({ complete: true, indexed: true, relabelled: 3 });
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual({ pageId: w.pageId });
  });

  it('when the count still includes the relabelled tickets, keeps the marker, blocks Simulate and finishes on the next click', async () => {
    const w = await simulatedWorld();
    w.world.countLag = 30;
    const first = await resetDemo(ACCOUNT, w.deps);
    expect(first).toMatchObject({ complete: false, indexed: false, message: INDEX_LAG_MESSAGE, deleted: { tripwires: 1 } });
    expect(repo.decisions.has(w.decisionId)).toBe(false);
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 30, resetPending: true });
    expect(w.deps.enqueueExtraction).toHaveBeenLastCalledWith(w.pageId, true, ACCOUNT);
    await expect(simulateBusyMonth(w.deps)).rejects.toThrow(/Reset demo" has not finished/);

    // Extraction recreated the decision meanwhile; the second click must not delete it again.
    const fresh = seedTripwire(repo, { decisionId: 'dec-fresh', status: 'proposed' });
    repo.decisions.set('dec-fresh', { ...repo.decisions.get('dec-fresh')!, pageId: w.pageId });
    w.world.countLag = 0;
    vi.mocked(w.deps.enqueueExtraction).mockClear();
    const second = await resetDemo(ACCOUNT, w.deps);
    expect(second).toMatchObject({ complete: true, indexed: true, deleted: null });
    expect(repo.tripwires.get(fresh.tripwireId)?.status).toBe('proposed');
    expect(w.deps.enqueueExtraction).not.toHaveBeenCalled();
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual({ pageId: w.pageId });
  });

  it.each(['revisit', 'extract'] as const)('refuses while the demo page %s lock is held, touching nothing', async (lock) => {
    const w = await simulatedWorld();
    repo.pageLocks.set(w.pageId, { [lock]: '2099-01-01T00:00:00.000Z' });
    await expect(resetDemo(ACCOUNT, w.deps)).rejects.toThrow(PAGE_BUSY_MESSAGE);
    expect(w.jira.updateLabels).not.toHaveBeenCalled();
    expect(repo.decisions.has(w.decisionId)).toBe(true);
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 30 });
    // Its own locks are released, the other holder's lock is kept.
    expect(repo.pageLocks.get(w.pageId)?.[lock]).toBe('2099-01-01T00:00:00.000Z');
    expect(repo.pageLocks.get(w.pageId)?.[lock === 'revisit' ? 'extract' : 'revisit']).toBeUndefined();
    expect(repo.appLocks.has(SIMULATE_LOCK)).toBe(false);
    expect(repo.appLocks.has(LOAD_LOCK)).toBe(false);
  });

  it('refuses while "Load demo data" runs', async () => {
    const w = await simulatedWorld();
    repo.appLocks.set(LOAD_LOCK, '2099-01-01T00:00:00.000Z');
    await expect(resetDemo(ACCOUNT, w.deps)).rejects.toThrow(BUSY_MESSAGE);
    expect(w.jira.updateLabels).not.toHaveBeenCalled();
  });

  it('lets Simulate run again afterwards and open a new Revisit', async () => {
    const w = await simulatedWorld();
    await resetDemo(ACCOUNT, w.deps);
    // Extraction + Accept again: a fresh confirmed tripwire on the demo page.
    const pageId = (repo.appValues.get(DEMO_STATE_KEY) as { pageId: string }).pageId;
    const decisionId = 'dec-again';
    repo.decisions.set(decisionId, { id: decisionId, pageId, statement: 'Defer CSV export', topics: [], status: 'active' });
    const fresh = seedTripwire(repo, { decisionId });
    w.jira.bulkCreateIssues.mockClear();
    w.deps.evaluate = vi.fn(async (ids: readonly string[]) => {
      if (!(await repo.findOpenRevisit(decisionId))) await repo.insertRevisit({ id: 'rv-again', decisionId, issueKey: 'SUP-140', tripwireId: ids[0], status: 'open' });
      return { results: ids.map((id) => ({ status: 'evaluated' as const, tripwireId: id, outcome: 'tripped' as const, value: 37, newStatus: 'tripped' as const, revisitRequested: true })), rateLimited: false };
    });
    const again = await simulateBusyMonth(w.deps);
    expect(w.jira.bulkCreateIssues.mock.calls[0]?.[1]).toHaveLength(30);
    expect(again).toMatchObject({ created: 30, issueCount: 37, indexed: true, revisits: [{ tripwireId: fresh.tripwireId, issueKey: 'SUP-140' }] });
  });

  it('keeps going when the Revisit issue cannot be closed and reports a warning', async () => {
    const w = await simulatedWorld();
    w.jira.transitionToDone.mockRejectedValueOnce(new Error('Jira 403: no permission'));
    const result = await resetDemo(ACCOUNT, w.deps);
    expect(result.complete).toBe(true);
    expect(result.warnings).toEqual(['Could not close SUP-99: Jira 403: no permission']);
    expect(repo.decisions.has(w.decisionId)).toBe(false);
  });

  it('stops before touching SQL when time runs out while relabelling', async () => {
    const w = await simulatedWorld();
    w.jira.updateLabels.mockImplementation(async () => w.advance(TIME_BUDGET_MS));
    const result = await resetDemo(ACCOUNT, w.deps);
    expect(result).toMatchObject({ complete: false, relabelled: 5, deleted: null, message: expect.stringContaining('Time ran out') });
    expect(repo.decisions.has(w.decisionId)).toBe(true);
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 30 });
  });

  it('refuses before "Load demo data" and while Simulate runs', async () => {
    const { deps } = makeDeps({ project: true, tickets: 7, labels: [] }, repo);
    await expect(resetDemo(ACCOUNT, deps)).rejects.toThrow(/Load demo data/);
    demoTripwire(repo);
    repo.appLocks.set(SIMULATE_LOCK, '2099-01-01T00:00:00.000Z');
    await expect(resetDemo(ACCOUNT, deps)).rejects.toThrow(BUSY_MESSAGE);
  });
});
