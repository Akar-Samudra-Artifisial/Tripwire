import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripwireRow } from '../src/adapters/repo';
import type { EvalOutcome } from '../src/core/evaluator';
import { fakeRepo, type FakeRepo } from './helpers/fakeRepo';
import { seedTripwire } from './helpers/seed';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

const {
  addDays,
  BILLING_JQL,
  BUSY_MESSAGE,
  DEMO,
  DEMO_JQL,
  DEMO_PAGES,
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
const NOW = Date.parse('2026-11-02T10:00:00Z');

interface Page {
  id: string;
  webUrl?: string;
  labels: string[];
}

interface World {
  project: boolean;
  /** Tickets labelled `export` at the start. */
  tickets: number;
  /** Tickets labelled `billing` at the start. */
  billing?: number;
  space?: { id: string; key: string };
  /** Pages by title. */
  pages?: Map<string, Page>;
  /** Issues Jira search does not see yet (index lag). */
  hidden?: Set<string>;
  /** Extra tickets the approximate `export` count still reports (index lag after relabelling). */
  countLag?: number;
}

const labelOf = (jql: string): string | undefined => /labels = ([a-z-]+)$/.exec(jql)?.[1];

function makeDeps(world: World, repo: FakeRepo, evaluate?: SeedDeps['evaluate']) {
  let clock = NOW;
  const pages = (world.pages ??= new Map());
  // Every SUP issue; the demo JQLs count them by label.
  const issues: { key: string; summary: string; labels: string[] }[] = [
    ...Array.from({ length: world.tickets }, (_, i) => ({ key: `SUP-${i + 1}`, summary: `Baseline ticket ${i + 1}`, labels: ['export'] })),
    ...Array.from({ length: world.billing ?? 0 }, (_, i) => ({ key: `SUP-${world.tickets + i + 1}`, summary: `Billing bug ${i + 1}`, labels: ['billing'] })),
  ];
  const countBy = (label: string | undefined) => issues.filter((i) => label !== undefined && i.labels.includes(label)).length;
  const jira = {
    getProject: vi.fn(async (key: string) => (world.project ? { id: '10000', key, name: DEMO.projectName } : undefined)),
    createProject: vi.fn(async (input: { key: string }) => {
      world.project = true;
      return { id: '10000', key: input.key };
    }),
    countIssues: vi.fn(async (jql: string) => {
      const label = labelOf(jql);
      return countBy(label) + (label === 'export' ? (world.countLag ?? 0) : 0);
    }),
    bulkCreateIssues: vi.fn(async (_key: string, created: readonly { summary: string; labels: string[] }[]) =>
      created.map((n) => {
        const key = `SUP-${issues.length + 1}`;
        issues.push({ key, summary: n.summary, labels: [...n.labels] });
        return key;
      }),
    ),
    searchIssues: vi.fn(async (jql: string, max: number) =>
      issues
        .filter((i) => !world.hidden?.has(i.key))
        .filter((i) => i.labels.some((l) => jql.includes(`labels = ${l}`)))
        .slice(0, max)
        .map((i) => structuredClone(i)),
    ),
    updateLabels: vi.fn(async (key: string, add: readonly string[], remove: readonly string[]) => {
      const issue = issues.find((i) => i.key === key)!;
      issue.labels = [...issue.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !issue.labels.includes(l))];
    }),
    transitionToDone: vi.fn(async (): Promise<string | undefined> => 'Done'),
    addComment: vi.fn(async () => undefined),
  };
  const byId = (id: string) => [...pages.values()].find((p) => p.id === id);
  const confluence = {
    findSpace: vi.fn(async () => world.space),
    createSpace: vi.fn(async (key: string) => (world.space = { id: '65537', key })),
    findPageByTitle: vi.fn(async (_space: string, title: string) => {
      const p = pages.get(title);
      return p ? { id: p.id, ...(p.webUrl ? { webUrl: p.webUrl } : {}) } : undefined;
    }),
    createPage: vi.fn(async (_space: string, title: string, _storage: string) => {
      const id = String(123 + pages.size);
      pages.set(title, { id, webUrl: `https://site/wiki/spaces/DEC/pages/${id}`, labels: [] });
      return { id, webUrl: `https://site/wiki/spaces/DEC/pages/${id}` };
    }),
    getPageLabels: vi.fn(async (id: string) => [...(byId(id)?.labels ?? [])]),
    addPageLabel: vi.fn(async (id: string, label: string) => {
      byId(id)?.labels.push(label);
    }),
    canEditPage: vi.fn(async (_id: string) => true),
    updatePage: vi.fn(async (_id: string, _storage: string, _message: string) => 2),
  };
  const deps: SeedDeps = {
    jira,
    confluence,
    repo,
    enqueueExtraction: vi.fn(async () => 'job-1'),
    enqueueEvaluation: vi.fn(async () => undefined),
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

/** Demo page with a confirmed tripwire, as after "Load demo data" + Accept, in the state written before the Lumora pages. */
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

describe('DEMO_PAGES (Lumora)', () => {
  it('has 8 pages from at least 4 teams, "Defer CSV export" first and unchanged', () => {
    expect(DEMO_PAGES).toHaveLength(8);
    expect(DEMO_PAGES[0]).toMatchObject({ slug: 'csv-export', title: 'Defer CSV export' });
    expect(DEMO_PAGES[0]!.storage('2030-01-01')).toContain('Fewer than 10 customer requests for CSV export per month');
    expect(new Set(DEMO_PAGES.map((p) => p.team)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(DEMO_PAGES.map((p) => p.title)).size).toBe(8);
    for (const p of DEMO_PAGES.slice(1)) expect(p.storage('2026-11-02')).toContain(`<strong>Owner team:</strong> ${p.team}`);
  });

  it('three contradicting pairs from different teams share a topic phrase', () => {
    const page = (slug: string) => DEMO_PAGES.find((p) => p.slug === slug)!;
    for (const [a, b, topic] of [
      ['go-services', 'node-experiments', 'backend language'],
      ['event-retention', 'transaction-retention', 'data retention'],
      ['mobile-freeze', 'year-end-promo', 'mobile release'],
    ] as const) {
      expect(page(a).team).not.toBe(page(b).team);
      expect(page(a).storage('2026-11-02')).toContain(topic);
      expect(page(b).storage('2026-11-02')).toContain(topic);
    }
  });

  it('writes dates relative to the day it is given', () => {
    const page = (slug: string) => DEMO_PAGES.find((p) => p.slug === slug)!;
    expect(addDays('2026-11-02', 3)).toBe('2026-11-05');
    expect(page('event-retention').storage('2026-11-02')).toContain('valid until 2026-11-05');
    expect(page('mobile-freeze').storage('2026-11-02')).toContain('starts on 2026-11-22');
    expect(page('year-end-promo').storage('2026-11-02')).toContain('on 2026-11-27');
    expect(page('year-end-promo').storage('2027-01-30')).toContain('on 2027-02-24');
  });
});

describe('loadDemoData', () => {
  it('creates project, tickets, space, the 8 labelled Lumora pages and settings on an empty site', async () => {
    const world: World = { project: false, tickets: 0 };
    const { deps, jira, confluence } = makeDeps(world, repo);

    const result = await loadDemoData(ACCOUNT, deps);

    expect(jira.createProject).toHaveBeenCalledWith(expect.objectContaining({ key: 'SUP', leadAccountId: ACCOUNT }));
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]).toHaveLength(7);
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]?.[0]).toMatchObject({ labels: ['export'] });
    expect(jira.bulkCreateIssues.mock.calls[1]?.[1]).toHaveLength(2);
    expect(jira.bulkCreateIssues.mock.calls[1]?.[1]?.[0]).toMatchObject({ labels: ['billing'] });
    expect(confluence.createSpace).toHaveBeenCalledWith('DEC', 'Decisions', expect.any(String));
    expect(confluence.createPage).toHaveBeenCalledTimes(8);
    expect(confluence.createPage).toHaveBeenNthCalledWith(1, '65537', 'Defer CSV export', expect.stringContaining('Fewer than 10 customer requests for CSV export per month'));
    // Dates come from the injected clock.
    expect(confluence.createPage).toHaveBeenCalledWith('65537', 'Delete event data after 90 days', expect.stringContaining('valid until 2026-11-05'));
    expect(confluence.addPageLabel).toHaveBeenCalledTimes(8);
    expect(confluence.addPageLabel).toHaveBeenCalledWith('123', 'decision');
    expect(deps.enqueueExtraction).toHaveBeenCalledTimes(8);
    expect(deps.enqueueExtraction).toHaveBeenCalledWith('123', false, ACCOUNT);
    expect(repo.settings).toMatchObject({ revisitProjectKey: 'SUP', decisionLabel: 'decision', allowedProjectKeys: ['SUP'] });
    const state = repo.appValues.get(DEMO_STATE_KEY) as { pageId: string; pages: Record<string, string> };
    expect(state.pageId).toBe('123');
    expect(Object.keys(state.pages)).toEqual(DEMO_PAGES.map((p) => p.slug));
    expect(result).toMatchObject({
      projectKey: 'SUP',
      revisitProjectKey: 'SUP',
      issueCount: 7,
      billingIssueCount: 2,
      pageId: '123',
      pageUrl: 'https://site/wiki/spaces/DEC/pages/123',
      canEdit: true,
      complete: true,
      extractionsQueued: 8,
      created: { project: true, issues: 7, billingIssues: 2, space: true, page: true, label: true, pages: 8 },
    });
    expect(result.pages.map((p) => p.title)).toEqual(DEMO_PAGES.map((p) => p.title));
  });

  it('is idempotent: a second Load creates no tickets, pages, labels or extractions', async () => {
    const world: World = { project: false, tickets: 0 };
    const { deps, jira, confluence, advance } = makeDeps(world, repo);
    await loadDemoData(ACCOUNT, deps);
    // Extraction ran for every page meanwhile.
    for (const p of world.pages!.values()) await repo.upsertDecision({ pageId: p.id, statement: 'x', topics: [], status: 'active' });
    const stateAfterFirst = structuredClone(repo.appValues.get(DEMO_STATE_KEY));
    vi.mocked(deps.enqueueExtraction).mockClear();
    jira.bulkCreateIssues.mockClear();
    confluence.createPage.mockClear();
    confluence.addPageLabel.mockClear();

    advance(61_000);
    const again = await loadDemoData(ACCOUNT, deps);

    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
    expect(confluence.createPage).not.toHaveBeenCalled();
    expect(confluence.addPageLabel).not.toHaveBeenCalled();
    expect(deps.enqueueExtraction).not.toHaveBeenCalled();
    expect(world.pages!.size).toBe(8);
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual(stateAfterFirst);
    expect(again).toMatchObject({ issueCount: 7, billingIssueCount: 2, extractionsQueued: 0, created: { issues: 0, billingIssues: 0, pages: 0 } });
  });

  it('reuses an existing project, space and labelled page, keeps settings and only adds missing tickets', async () => {
    const world: World = {
      project: true,
      tickets: 4,
      billing: 2,
      space: { id: '65537', key: 'DEC' },
      pages: new Map([['Defer CSV export', { id: '55', labels: ['adr'] }]]),
    };
    repo.settings = { decisionLabel: 'adr', watchedSpaceKeys: ['ENG'], allowedProjectKeys: ['OPS', 'SUP'], revisitProjectKey: 'OPS' };
    await repo.upsertDecision({ pageId: '55', statement: 'Defer CSV export', topics: [], status: 'active' });
    const { deps, jira, confluence } = makeDeps(world, repo);

    const result = await loadDemoData(ACCOUNT, deps);

    expect(jira.createProject).not.toHaveBeenCalled();
    expect(confluence.createSpace).not.toHaveBeenCalled();
    expect(confluence.createPage).not.toHaveBeenCalledWith(expect.anything(), 'Defer CSV export', expect.anything());
    expect(confluence.addPageLabel).not.toHaveBeenCalledWith('55', expect.anything());
    expect(deps.enqueueExtraction).not.toHaveBeenCalledWith('55', expect.anything(), expect.anything());
    expect(jira.bulkCreateIssues).toHaveBeenCalledTimes(1);
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]).toHaveLength(3);
    expect(repo.settings).toEqual({ revisitProjectKey: 'OPS', decisionLabel: 'adr', watchedSpaceKeys: ['ENG', 'DEC'], allowedProjectKeys: ['OPS', 'SUP'] });
    expect(result.created).toMatchObject({ project: false, issues: 3, billingIssues: 0, space: false, page: false, label: false, pages: 7 });
    expect(result).toMatchObject({ issueCount: 7, revisitProjectKey: 'OPS', pageId: '55' });
  });

  it('upgrades a state written before the Lumora pages (only pageId)', async () => {
    const world: World = { project: true, tickets: 7, billing: 2, space: { id: '1', key: 'DEC' }, pages: new Map([['Defer CSV export', { id: '55', labels: ['decision'] }]]) };
    repo.appValues.set(DEMO_STATE_KEY, { pageId: '55', simulatedTickets: 30 });
    const { deps } = makeDeps(world, repo);
    await loadDemoData(ACCOUNT, deps);
    const state = repo.appValues.get(DEMO_STATE_KEY) as Record<string, unknown>;
    expect(state).toMatchObject({ pageId: '55', simulatedTickets: 30 });
    expect(Object.keys(state.pages as object)).toHaveLength(8);
    expect((state.pages as Record<string, string>)['csv-export']).toBe('55');
  });

  it('stops creating pages when the time budget is used up, and a later click continues', async () => {
    const world: World = { project: true, tickets: 7, billing: 2, space: { id: '1', key: 'DEC' } };
    const made = makeDeps(world, repo);
    made.confluence.createPage.mockImplementation(async (_s: string, title: string) => {
      const id = String(200 + world.pages!.size);
      world.pages!.set(title, { id, labels: [] });
      if (world.pages!.size === 3) made.advance(TIME_BUDGET_MS);
      return { id, webUrl: `https://site/wiki/pages/${id}` };
    });
    const first = await loadDemoData(ACCOUNT, made.deps);
    expect(first).toMatchObject({ complete: false });
    expect(first.pages).toHaveLength(3);
    made.advance(61_000);
    const second = await loadDemoData(ACCOUNT, made.deps);
    expect(second).toMatchObject({ complete: true, created: { pages: 5 } });
    expect(world.pages!.size).toBe(8);
  });

  it('refuses a second click while the first holds the lock (no duplicate tickets)', async () => {
    const world: World = { project: true, tickets: 0 };
    const { deps, jira } = makeDeps(world, repo);
    const [first, second] = await Promise.allSettled([loadDemoData(ACCOUNT, deps), loadDemoData(ACCOUNT, deps)]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: new SeedError(BUSY_MESSAGE) });
    expect(jira.bulkCreateIssues).toHaveBeenCalledTimes(2); // export + billing, once
  });

  it('releases the lock when seeding fails', async () => {
    const world: World = { project: true, tickets: 0 };
    const { deps, confluence } = makeDeps(world, repo);
    confluence.findSpace.mockRejectedValueOnce(new Error('Confluence 500'));
    await expect(loadDemoData(ACCOUNT, deps)).rejects.toThrow('Confluence 500');
    expect(repo.appLocks.has(LOAD_LOCK)).toBe(false);
  });

  it('validates the merged settings before creating anything', async () => {
    repo.settings = { decisionLabel: 'decision', watchedSpaceKeys: [], allowedProjectKeys: Array.from({ length: 20 }, (_, i) => `P${i}X`) };
    const { deps, jira, confluence } = makeDeps({ project: false, tickets: 0 }, repo);
    await expect(loadDemoData(ACCOUNT, deps)).rejects.toBeInstanceOf(SettingsError);
    expect(jira.createProject).not.toHaveBeenCalled();
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
    expect(confluence.createSpace).not.toHaveBeenCalled();
  });

  it('labels an existing unlabelled page, queues extraction and reports when the caller cannot edit it', async () => {
    const world: World = { project: true, tickets: 7, space: { id: '1', key: 'DEC' }, pages: new Map([['Defer CSV export', { id: '55', labels: [] }]]) };
    const { deps, confluence } = makeDeps(world, repo);
    confluence.canEditPage.mockResolvedValueOnce(false);
    const result = await loadDemoData(ACCOUNT, deps);
    expect(confluence.addPageLabel).toHaveBeenCalledWith('55', 'decision');
    expect(deps.enqueueExtraction).toHaveBeenCalledWith('55', false, ACCOUNT);
    expect(result.canEdit).toBe(false);
  });

  it('rejects a malformed account id', async () => {
    const { deps } = makeDeps({ project: false, tickets: 0 }, repo);
    await expect(loadDemoData('bad id; drop', deps)).rejects.toBeInstanceOf(SeedError);
  });
});

/** Extracted Lumora decision for `slug` with one tripwire per spec. */
function lumoraDecision(r: FakeRepo, slug: string, pageId: string, tripwires: Partial<TripwireRow>[]): { decisionId: string; tripwireIds: string[] } {
  const decisionId = `dec-${slug}`;
  r.decisions.set(decisionId, { id: decisionId, pageId, statement: slug, topics: [slug], status: 'active', pageVersion: 4 });
  const tripwireIds = tripwires.map((t, i) => {
    const assumptionId = `asm-${slug}-${i}`;
    r.assumptions.set(assumptionId, { id: assumptionId, decisionId, quote: `${slug} quote ${i}`, summary: `${slug} summary ${i}` });
    const id = `tw-${slug}-${i}`;
    r.tripwires.set(id, {
      id,
      assumptionId,
      kind: 'checkin',
      spec: { every: 'quarter', question: 'Still true?' },
      status: 'proposed',
      strikes: 0,
      lastValue: null,
      lastOutcome: null,
      lastEvaluatedAt: null,
      baselineVersion: null,
      ...t,
    } as TripwireRow);
    return id;
  });
  return { decisionId, tripwireIds };
}

/** The full Lumora state: main page with a confirmed tripwire plus four other demo pages with proposed tripwires. */
function lumoraWorld(r: FakeRepo) {
  const main = seedTripwire(r, { status: 'active' });
  const mainPageId = r.decisions.get(main.decisionId)!.pageId;
  const stripe = lumoraDecision(r, 'stripe-billing', '301', [{ kind: 'jql_threshold', spec: { jql: BILLING_JQL, op: '>=', value: 5 } }]);
  const go = lumoraDecision(r, 'go-services', '302', [{ kind: 'checkin', spec: { every: 'quarter', question: 'Still true?' } }]);
  const node = lumoraDecision(r, 'node-experiments', '303', [{ kind: 'content_change', spec: { pageId: '303', watch: 'any_edit' } }]);
  const retention = lumoraDecision(r, 'event-retention', '304', [{ kind: 'date', spec: { date: '2026-11-05', leadDays: 30 } }]);
  r.appValues.set(DEMO_STATE_KEY, {
    pageId: mainPageId,
    pages: { 'csv-export': mainPageId, 'stripe-billing': '301', 'go-services': '302', 'node-experiments': '303', 'event-retention': '304' },
  });
  return { main, mainPageId, stripe, go, node, retention };
}

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

  it('adds 30 export + 6 billing tickets and evaluates only the demo decision tripwires, twice (state with only pageId)', async () => {
    const { tripwireId, decisionId } = demoTripwire(repo);
    seedTripwire(repo, { status: 'active' }); // another team's decision: must not be evaluated
    const evaluate = tripping(decisionId);
    const { deps, jira } = makeDeps({ project: true, tickets: 7, billing: 2 }, repo, evaluate);

    const result = await simulateBusyMonth(deps, ACCOUNT);

    const created = jira.bulkCreateIssues.mock.calls[0]?.[1] ?? [];
    expect(created).toHaveLength(36);
    expect(created.filter((t) => t.labels.includes('export'))).toHaveLength(30);
    expect(created.filter((t) => t.labels.includes('billing'))).toHaveLength(6);
    expect(jira.countIssues).toHaveBeenCalledWith(DEMO_JQL);
    expect(jira.countIssues).toHaveBeenCalledWith(BILLING_JQL);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenNthCalledWith(1, [tripwireId]);
    expect(evaluate).toHaveBeenNthCalledWith(2, [tripwireId]);
    expect(deps.enqueueEvaluation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 36, issueCount: 37, billingIssueCount: 8, indexed: true, complete: true, confirmed: 0, queued: 0, revisits: [{ tripwireId, issueKey: 'SUP-99' }] });
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 36 });
    expect(repo.appLocks.has(SIMULATE_LOCK)).toBe(false);
  });

  it('Lumora: confirms the other demo pages, evaluates Jira counts inline and queues the rest after ageing them', async () => {
    const w = lumoraWorld(repo);
    const other = seedTripwire(repo, { status: 'proposed' }); // not a demo page: never confirmed
    const evaluate = tripping(w.main.decisionId);
    const { deps, confluence } = makeDeps({ project: true, tickets: 7, billing: 2 }, repo, evaluate);
    // The admin cannot edit the Go page: its tripwire stays proposed, like Accept would refuse.
    confluence.canEditPage.mockImplementation(async (id: string) => id !== '302');

    const result = await simulateBusyMonth(deps, ACCOUNT);

    expect(result).toMatchObject({ confirmed: 3, queued: 2, complete: true });
    expect(repo.tripwires.get(w.stripe.tripwireIds[0]!)).toMatchObject({ status: 'active', confirmedBy: ACCOUNT });
    expect(repo.tripwires.get(w.node.tripwireIds[0]!)).toMatchObject({ status: 'active', baselineVersion: 4 });
    expect(repo.tripwires.get(w.go.tripwireIds[0]!)?.status).toBe('proposed');
    expect(repo.tripwires.get(other.tripwireId)?.status).toBe('proposed');
    // Jira counts need two strikes: evaluated inline with the main tripwire.
    expect(evaluate).toHaveBeenNthCalledWith(1, [w.main.tripwireId, w.stripe.tripwireIds[0]]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(deps.enqueueEvaluation).toHaveBeenCalledWith([w.node.tripwireIds[0], w.retention.tripwireIds[0]]);
    // A month passed: the date is yesterday and the watched page got a new version.
    expect((repo.tripwires.get(w.retention.tripwireIds[0]!)?.spec as { date: string }).date).toBe('2026-11-01');
    expect(confluence.updatePage).toHaveBeenCalledTimes(1);
    expect(confluence.updatePage).toHaveBeenCalledWith('303', expect.stringContaining('Reviewed 2026-11-02'), expect.any(String));
    expect(confluence.updatePage.mock.calls[0]?.[1]).toContain('Node.js with TypeScript');
  });

  it('moves date/checkin a month on and edits the page for content_change before evaluating', async () => {
    const { decisionId, assumptionId } = demoTripwire(repo);
    const base = { assumptionId, status: 'active' as const, confirmedBy: 'owner-1', strikes: 0, lastValue: null, lastOutcome: null, lastEvaluatedAt: null };
    repo.tripwires.set('tw-date', { ...base, id: 'tw-date', kind: 'date', spec: { date: '2027-03-31', leadDays: 30 }, confirmedAt: '2026-10-01T00:00:00.000Z', baselineVersion: null });
    repo.tripwires.set('tw-done', { ...base, id: 'tw-done', kind: 'date', spec: { date: '2026-10-01', leadDays: 3, resolved: true }, baselineVersion: null });
    repo.tripwires.set('tw-check', { ...base, id: 'tw-check', kind: 'checkin', spec: { every: 'quarter', question: 'Still on PDF?' }, confirmedAt: '2026-11-01T00:00:00.000Z', baselineVersion: null });
    repo.tripwires.set('tw-page', { ...base, id: 'tw-page', kind: 'content_change', spec: { pageId: '1', watch: 'any_edit' }, baselineVersion: 1 });
    const { deps, confluence } = makeDeps({ project: true, tickets: 7 }, repo, tripping(decisionId));

    await simulateBusyMonth(deps, ACCOUNT);

    expect(repo.tripwires.get('tw-date')?.spec).toEqual({ date: '2026-11-01', leadDays: 30 });
    expect(repo.tripwires.get('tw-done')?.spec).toEqual({ date: '2026-10-01', leadDays: 3, resolved: true });
    // quarter = 91 days, plus one: overdue by a day.
    expect(repo.tripwires.get('tw-check')?.confirmedAt).toBe(new Date(NOW - 92 * 86_400_000).toISOString());
    const pageId = repo.decisions.get(decisionId)!.pageId;
    expect(confluence.updatePage).toHaveBeenCalledTimes(1);
    expect(confluence.updatePage).toHaveBeenCalledWith(pageId, expect.stringContaining('Reviewed 2026-11-02'), expect.any(String));
    expect(confluence.updatePage.mock.calls[0]?.[1]).toContain('Fewer than 10 customer requests for CSV export per month');
  });

  it('lists each Revisit once, only for the tripwire that owns it', async () => {
    const { tripwireId, decisionId } = demoTripwire(repo);
    const second = seedTripwire(repo, { status: 'active', decisionId });
    const { deps } = makeDeps({ project: true, tickets: 7 }, repo, tripping(decisionId));
    const result = await simulateBusyMonth(deps, ACCOUNT);
    expect(result.revisits).toEqual([{ tripwireId, issueKey: 'SUP-99' }]);
    expect(result.revisits.some((r) => r.tripwireId === second.tripwireId)).toBe(false);
  });

  it('a second click reuses the tickets and only evaluates', async () => {
    const { decisionId } = demoTripwire(repo);
    const { deps, jira } = makeDeps({ project: true, tickets: 7 }, repo, tripping(decisionId));
    await simulateBusyMonth(deps, ACCOUNT);
    jira.bulkCreateIssues.mockClear();
    const again = await simulateBusyMonth(deps, ACCOUNT);
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
    expect(again).toMatchObject({ created: 0, issueCount: 37, indexed: true });
    expect(again.passes).toHaveLength(2);
  });

  it('refuses a concurrent click', async () => {
    demoTripwire(repo);
    repo.appLocks.set(SIMULATE_LOCK, '2099-01-01T00:00:00.000Z');
    const { deps, jira } = makeDeps({ project: true, tickets: 7 }, repo);
    await expect(simulateBusyMonth(deps, ACCOUNT)).rejects.toThrow(BUSY_MESSAGE);
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
  });

  it('does not evaluate (or queue) while Jira search has not caught up, and says so', async () => {
    lumoraWorld(repo);
    const { deps, jira } = makeDeps({ project: true, tickets: 7 }, repo);
    jira.countIssues.mockResolvedValue(7);
    const result = await simulateBusyMonth(deps, ACCOUNT);
    expect(deps.sleep).toHaveBeenCalled();
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.enqueueEvaluation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 36, indexed: false, complete: false, passes: [], queued: 0 });
  });

  it('stops before the second pass when the time budget is used up', async () => {
    const { decisionId } = demoTripwire(repo);
    const made = makeDeps({ project: true, tickets: 7 }, repo);
    const evaluate = vi.fn(async (ids: readonly string[]) => {
      made.advance(TIME_BUDGET_MS);
      return tripping(decisionId)(ids);
    });
    made.deps.evaluate = evaluate;
    const result = await simulateBusyMonth(made.deps, ACCOUNT);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ complete: false });
  });

  it('refuses without a confirmed tripwire on the demo page and creates or confirms nothing', async () => {
    const w = lumoraWorld(repo);
    repo.tripwires.get(w.main.tripwireId)!.status = 'proposed';
    seedTripwire(repo, { status: 'active' });
    const { deps, jira } = makeDeps({ project: true, tickets: 7 }, repo);
    await expect(simulateBusyMonth(deps, ACCOUNT)).rejects.toThrow(/accept its tripwire/);
    expect(jira.bulkCreateIssues).not.toHaveBeenCalled();
    expect(repo.tripwires.get(w.stripe.tripwireIds[0]!)?.status).toBe('proposed');
  });

  it('refuses before "Load demo data" ran, and a malformed account id', async () => {
    seedTripwire(repo, { status: 'active' });
    const { deps } = makeDeps({ project: true, tickets: 0 }, repo);
    await expect(simulateBusyMonth(deps, ACCOUNT)).rejects.toThrow(/Load demo data/);
    await expect(simulateBusyMonth(deps, 'bad id')).rejects.toBeInstanceOf(SeedError);
  });
});

describe('resetDemo', () => {
  /** Demo decision after Simulate: tripwire revisiting, 2 evaluations, an open Revisit, 36 busy month tickets. */
  async function simulatedWorld() {
    const { decisionId, tripwireId, assumptionId } = demoTripwire(repo);
    const other = seedTripwire(repo, { status: 'revisiting' }); // another decision: must survive the reset
    await repo.insertRevisit({ id: 'rv-other', decisionId: other.decisionId, issueKey: 'OPS-5', tripwireId: other.tripwireId, status: 'open' });
    const world: World = { project: true, tickets: 7, billing: 2 };
    const made = makeDeps(world, repo, tripping(decisionId));
    await simulateBusyMonth(made.deps, ACCOUNT);
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

  const exportKeys = (issues: { key: string; labels: string[] }[], label = 'export') => issues.filter((i) => i.labels.includes(label)).map((i) => i.key);

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
    const { deps, jira } = makeDeps({ project: true, tickets: 7 }, repo);
    await simulateBusyMonth(deps, ACCOUNT);
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]?.[0]).toMatchObject({ labels: ['export', 'tripwire-demo-sim'] });
    expect(jira.bulkCreateIssues.mock.calls[0]?.[1]?.[35]).toMatchObject({ labels: ['billing', 'tripwire-demo-sim'] });
  });

  it('removes only demo data: busy month tickets, demo Revisit, demo decision rows and the simulate marker', async () => {
    const w = await simulatedWorld();
    // An unlabelled ticket from an old run (summary pattern) and tickets a person added by hand.
    w.issues.push({ key: 'SUP-200', summary: 'Export dashboard widgets to CSV (#3)', labels: ['export'] });
    w.issues.push({ key: 'SUP-201', summary: 'Real customer: CSV please', labels: ['export'] });
    w.issues.push({ key: 'SUP-202', summary: 'Real customer: double charge', labels: ['billing'] });
    const cas = vi.spyOn(repo, 'casTripwire');
    const result = await resetDemo(ACCOUNT, w.deps);

    expect(w.jira.searchIssues).toHaveBeenCalledWith('project = SUP AND (labels = export OR labels = billing OR labels = tripwire-demo-sim)', expect.any(Number));
    // Archived before the rows go, so an evaluation that read the tripwire earlier loses its CAS.
    expect(cas).toHaveBeenCalledWith(w.tripwireId, expect.arrayContaining(['revisiting', 'active']), { status: 'archived' });
    expect(result).toMatchObject({ relabelled: 37, remaining: 8, revisitIssueKeys: ['SUP-99'], decisionsReset: 1, complete: true, indexed: true, warnings: [] });
    expect(result.deleted).toEqual({ tripwires: 1, assumptions: 1, evaluations: 2, revisits: 1 });
    expect(exportKeys(w.issues)).toEqual(['SUP-1', 'SUP-2', 'SUP-3', 'SUP-4', 'SUP-5', 'SUP-6', 'SUP-7', 'SUP-201']);
    expect(exportKeys(w.issues, 'billing')).toEqual(['SUP-8', 'SUP-9', 'SUP-202']);
    expect(w.jira.updateLabels).toHaveBeenCalledWith('SUP-200', ['tripwire-demo-sim'], ['export']);
    expect(w.jira.updateLabels).not.toHaveBeenCalledWith('SUP-201', expect.anything(), expect.anything());
    expect(w.jira.updateLabels).not.toHaveBeenCalledWith('SUP-202', expect.anything(), expect.anything());
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

  it('Lumora: resets every demo decision and its Radar pairs, refreshes page dates, leaves non-demo data alone', async () => {
    const w = lumoraWorld(repo);
    const other = seedTripwire(repo, { status: 'revisiting' });
    const otherB = seedTripwire(repo, { status: 'active' });
    await repo.insertRevisit({ id: 'rv-go', decisionId: w.go.decisionId, issueKey: 'SUP-120', tripwireId: w.go.tripwireIds[0], status: 'open' });
    await repo.insertRevisit({ id: 'rv-other', decisionId: other.decisionId, issueKey: 'OPS-5', tripwireId: other.tripwireId, status: 'open' });
    const pair = (x: string, y: string) => repo.upsertRadarPair({ decisionAId: x < y ? x : y, decisionBId: x < y ? y : x, hashA: 'h', hashB: 'h', status: 'open', confidence: 0.9, summary: 's', sharedTopics: ['x'] });
    await pair(w.go.decisionId, w.node.decisionId);
    await pair(w.retention.decisionId, other.decisionId);
    await pair(other.decisionId, otherB.decisionId);
    const { deps, confluence, jira } = makeDeps({ project: true, tickets: 7, billing: 2 }, repo);

    const result = await resetDemo(ACCOUNT, deps);

    expect(result).toMatchObject({ complete: true, decisionsReset: 5, extractionsQueued: 5, revisitIssueKeys: ['SUP-120'] });
    for (const d of [w.main, w.stripe, w.go, w.node, w.retention]) expect(repo.decisions.has(d.decisionId)).toBe(false);
    expect(repo.decisions.has(other.decisionId)).toBe(true);
    expect(repo.revisits.get('rv-other')?.status).toBe('open');
    expect([...repo.radarPairs.values()].map((p) => [p.decisionAId, p.decisionBId].sort())).toEqual([[other.decisionId, otherB.decisionId].sort()]);
    expect(jira.transitionToDone).toHaveBeenCalledWith('SUP-120');
    // Lumora pages get today's dates back; "Defer CSV export" is not edited.
    expect(confluence.updatePage).toHaveBeenCalledTimes(4);
    expect(confluence.updatePage).toHaveBeenCalledWith('304', expect.stringContaining('valid until 2026-11-05'), expect.any(String));
    expect(confluence.updatePage).not.toHaveBeenCalledWith(w.mainPageId, expect.anything(), expect.anything());
    for (const id of [w.mainPageId, '301', '302', '303', '304']) expect(deps.enqueueExtraction).toHaveBeenCalledWith(id, true, ACCOUNT);
    expect(result.extractionJobId).toBe('job-1');
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual({
      pageId: w.mainPageId,
      pages: { 'csv-export': w.mainPageId, 'stripe-billing': '301', 'go-services': '302', 'node-experiments': '303', 'event-retention': '304' },
    });
  });

  it('Lumora: when time runs out between decisions, the next click finishes without deleting re-extracted ones', async () => {
    const w = lumoraWorld(repo);
    const made = makeDeps({ project: true, tickets: 7, billing: 2 }, repo);
    made.confluence.updatePage.mockImplementation(async (id: string) => {
      if (id === '301') made.advance(TIME_BUDGET_MS);
      return 2;
    });
    const first = await resetDemo(ACCOUNT, made.deps);
    expect(first).toMatchObject({ complete: false, decisionsReset: 2, extractionsQueued: 2, message: expect.stringContaining('Time ran out') });
    expect(repo.decisions.has(w.go.decisionId)).toBe(true);
    await expect(simulateBusyMonth(made.deps, ACCOUNT)).rejects.toThrow(/Reset demo" has not finished/);

    // Extraction recreated the main decision meanwhile; the next click must leave it alone.
    const fresh = seedTripwire(repo, { decisionId: 'dec-fresh', status: 'proposed' });
    repo.decisions.set('dec-fresh', { ...repo.decisions.get('dec-fresh')!, pageId: w.mainPageId });
    made.advance(61_000);
    vi.mocked(made.deps.enqueueExtraction).mockClear();
    const second = await resetDemo(ACCOUNT, made.deps);
    expect(second).toMatchObject({ complete: true, decisionsReset: 3 });
    expect(repo.tripwires.get(fresh.tripwireId)?.status).toBe('proposed');
    expect(made.deps.enqueueExtraction).not.toHaveBeenCalledWith(w.mainPageId, true, ACCOUNT);
    expect(repo.appValues.get(DEMO_STATE_KEY)).not.toHaveProperty('resetPageIds');
  });

  it('relabels remembered busy month tickets by key even when search does not see them yet', async () => {
    const w = await simulatedWorld();
    w.world.hidden = new Set(['SUP-10', 'SUP-11']);
    const result = await resetDemo(ACCOUNT, w.deps);
    expect(w.jira.updateLabels).toHaveBeenCalledWith('SUP-10', ['tripwire-demo-sim'], ['export', 'billing']);
    expect(w.jira.updateLabels).toHaveBeenCalledWith('SUP-12', ['tripwire-demo-sim'], ['export']);
    expect(result).toMatchObject({ relabelled: 36, complete: true, indexed: true });
  });

  it('keeps the marker and the decision when search has not caught up with the busy month (no remembered keys)', async () => {
    const w = await simulatedWorld();
    // State written before Simulate remembered keys.
    repo.appValues.set(DEMO_STATE_KEY, { pageId: w.pageId, simulatedTickets: 36 });
    w.world.hidden = new Set(['SUP-30', 'SUP-31', 'SUP-32']);
    const result = await resetDemo(ACCOUNT, w.deps);
    expect(result).toMatchObject({ complete: false, indexed: false, deleted: null, message: INDEX_LAG_MESSAGE, relabelled: 33 });
    expect(repo.appValues.get(DEMO_STATE_KEY)).toEqual({ pageId: w.pageId, simulatedTickets: 36 });
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
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 36, resetPending: true });
    expect(w.deps.enqueueExtraction).toHaveBeenLastCalledWith(w.pageId, true, ACCOUNT);
    await expect(simulateBusyMonth(w.deps, ACCOUNT)).rejects.toThrow(/Reset demo" has not finished/);

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
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 36 });
    // Its own locks are released, the other holder's lock is kept.
    expect(repo.pageLocks.get(w.pageId)?.[lock]).toBe('2099-01-01T00:00:00.000Z');
    expect(repo.pageLocks.get(w.pageId)?.[lock === 'revisit' ? 'extract' : 'revisit']).toBeUndefined();
    expect(repo.appLocks.has(SIMULATE_LOCK)).toBe(false);
    expect(repo.appLocks.has(LOAD_LOCK)).toBe(false);
  });

  it('refuses while any Lumora page is locked, releasing the locks it took', async () => {
    const w = lumoraWorld(repo);
    repo.pageLocks.set('303', { extract: '2099-01-01T00:00:00.000Z' });
    const { deps } = makeDeps({ project: true, tickets: 7 }, repo);
    await expect(resetDemo(ACCOUNT, deps)).rejects.toThrow(PAGE_BUSY_MESSAGE);
    expect(repo.decisions.has(w.main.decisionId)).toBe(true);
    for (const id of [w.mainPageId, '301', '302']) expect(repo.pageLocks.get(id)?.revisit).toBeUndefined();
    expect(repo.pageLocks.get('303')?.extract).toBe('2099-01-01T00:00:00.000Z');
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
    const again = await simulateBusyMonth(w.deps, ACCOUNT);
    expect(w.jira.bulkCreateIssues.mock.calls[0]?.[1]).toHaveLength(36);
    expect(again).toMatchObject({ created: 36, issueCount: 37, billingIssueCount: 8, indexed: true, revisits: [{ tripwireId: fresh.tripwireId, issueKey: 'SUP-140' }] });
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
    expect(repo.appValues.get(DEMO_STATE_KEY)).toMatchObject({ simulatedTickets: 36 });
  });

  it('refuses before "Load demo data" and while Simulate runs', async () => {
    const { deps } = makeDeps({ project: true, tickets: 7 }, repo);
    await expect(resetDemo(ACCOUNT, deps)).rejects.toThrow(/Load demo data/);
    demoTripwire(repo);
    repo.appLocks.set(SIMULATE_LOCK, '2099-01-01T00:00:00.000Z');
    await expect(resetDemo(ACCOUNT, deps)).rejects.toThrow(BUSY_MESSAGE);
  });
});
