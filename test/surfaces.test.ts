import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeRepo } from './helpers/fakeRepo';

// --- Forge platform mocks ---------------------------------------------------------------------------
const forge = vi.hoisted(() => ({
  defs: new Map<string, (req: { payload?: unknown; context: unknown }) => unknown>(),
  push: vi.fn(),
  canEditPage: vi.fn<(pageId: string) => Promise<boolean>>(),
  viewPageAsUser: vi.fn<(pageId: string) => Promise<{ title: string; webUrl?: string } | undefined>>(),
  evaluateMany: vi.fn(),
  repo: { current: undefined as unknown },
}));

vi.mock('@forge/resolver', () => ({
  default: class {
    define(name: string, fn: (req: { payload?: unknown; context: unknown }) => unknown) {
      forge.defs.set(name, fn);
    }
    getDefinitions() {
      return {};
    }
  },
}));
vi.mock('@forge/events', () => ({
  Queue: class {
    push = forge.push;
  },
  InvocationError: class {
    constructor(readonly options: unknown) {}
  },
  InvocationErrorCode: { FUNCTION_UPSTREAM_RATE_LIMITED: 'FUNCTION_UPSTREAM_RATE_LIMITED' },
}));
vi.mock('@forge/api', () => ({
  default: {},
  route: () => '',
  isForgePlatformError: (err: Error) => err.name === 'NeedsAuthenticationError',
}));
vi.mock('@forge/llm', () => ({ chat: vi.fn(), ForgeLlmError: class extends Error {} }));
vi.mock('../src/adapters/sql', () => ({
  ensureSchema: async () => undefined,
  listAppliedMigrations: async () => [],
  query: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../src/adapters/confluence', () => ({
  confluence: { canEditPage: forge.canEditPage, getPage: vi.fn(), viewPageAsUser: forge.viewPageAsUser, getPageLabels: async () => [] },
}));
vi.mock('../src/adapters/repo', async (importActual) => ({
  ...(await importActual<typeof import('../src/adapters/repo')>()),
  get sqlRepo() {
    return forge.repo.current;
  },
}));
vi.mock('../src/core/evaluator', async (importActual) => ({
  ...(await importActual<typeof import('../src/core/evaluator')>()),
  evaluateMany: forge.evaluateMany,
}));

const { fakeRepo } = await import('./helpers/fakeRepo');
const { seedTripwire } = await import('./helpers/seed');
const { EvaluationRateLimitedError } = await import('../src/core/evaluator');
const { evaluateBatch, MAX_EVALUATE_ATTEMPTS, onPageEvent, retryLater } = await import('../src/surfaces/background');
await import('../src/surfaces/ui');

let repo: FakeRepo;

const call = (name: string, pageId: string, payload?: unknown) => {
  const fn = forge.defs.get(name);
  if (!fn) throw new Error(`resolver ${name} not defined`);
  return fn({ payload, context: { moduleKey: 'tripwire-byline', accountId: 'user-1', extension: { content: { id: pageId } } } }) as Promise<
    Record<string, unknown>
  >;
};

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  repo = fakeRepo();
  repo.settings = { ...repo.settings, revisitProjectKey: 'SUP', allowedProjectKeys: ['SUP'] };
  forge.repo.current = repo;
  forge.push.mockReset().mockResolvedValue({ jobId: 'job-1' });
  forge.canEditPage.mockReset().mockResolvedValue(true);
  forge.viewPageAsUser.mockReset().mockResolvedValue({ title: 'Defer CSV export', webUrl: 'https://site/wiki/pages/1' });
  forge.evaluateMany.mockReset();
});

describe('onPageEvent: content_change', () => {
  it('queues an evaluation of the page’s confirmed content_change tripwires only', async () => {
    const watched = seedTripwire(repo);
    const pageId = repo.decisions.get(watched.decisionId)!.pageId;
    repo.tripwires.set(watched.tripwireId, { ...repo.tripwires.get(watched.tripwireId)!, kind: 'content_change', spec: { pageId, watch: 'any_edit' }, baselineVersion: 3 });
    seedTripwire(repo, { decisionId: watched.decisionId }); // jql_threshold on the same page: not queued
    const proposed = seedTripwire(repo, { decisionId: watched.decisionId, status: 'proposed' });
    repo.tripwires.set(proposed.tripwireId, { ...repo.tripwires.get(proposed.tripwireId)!, kind: 'content_change', spec: { pageId, watch: 'any_edit' } });

    await onPageEvent({ eventType: 'avi:confluence:updated:page', content: { id: pageId } });

    expect(forge.push).toHaveBeenCalledTimes(1);
    expect(forge.push).toHaveBeenCalledWith([{ body: { tripwireIds: [watched.tripwireId], attempt: 1 } }]);
  });

  it('queues nothing for a page without a decision', async () => {
    await onPageEvent({ eventType: 'avi:confluence:updated:page', content: { id: '424242' } });
    expect(forge.push).not.toHaveBeenCalled();
  });
});

describe('scanPage (S2)', () => {
  it('refuses callers who cannot edit the page', async () => {
    forge.canEditPage.mockResolvedValue(false);
    expect(await call('scanPage', '777')).toEqual({ error: 'Only people who can edit this page can scan it.' });
    expect(forge.push).not.toHaveBeenCalled();
  });

  it('allows one scan per page per 60 seconds', async () => {
    expect(await call('scanPage', '777')).toEqual({ jobId: 'job-1' });
    expect(await call('scanPage', '777')).toMatchObject({ error: expect.stringContaining('less than 60 seconds ago') });
    expect(await call('scanPage', '778')).toEqual({ jobId: 'job-1' });
    expect(forge.push).toHaveBeenCalledTimes(2);
  });

  it('lets Forge platform errors (consent prompt) through instead of swallowing them', async () => {
    forge.canEditPage.mockRejectedValue(Object.assign(new Error('needs auth'), { name: 'NeedsAuthenticationError' }));
    await expect(call('scanPage', '777')).rejects.toThrow('needs auth');
  });
});

describe('confirmTripwire (S1, S2)', () => {
  const proposed = () => {
    const seeded = seedTripwire(repo, { status: 'proposed' });
    const pageId = repo.decisions.get(seeded.decisionId)!.pageId;
    return { ...seeded, pageId };
  };

  it('refuses callers who cannot edit the page and leaves the tripwire proposed', async () => {
    const { tripwireId, pageId } = proposed();
    forge.canEditPage.mockResolvedValue(false);
    expect(await call('confirmTripwire', pageId, { tripwireId, action: 'accept' })).toEqual({
      error: 'Only people who can edit this page can confirm tripwires.',
    });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('proposed');
  });

  it('rejects an edited JQL outside the allowed projects', async () => {
    const { tripwireId, pageId } = proposed();
    const result = await call('confirmTripwire', pageId, {
      tripwireId,
      action: 'edit',
      spec: { jql: 'project = HR AND labels = salary', op: '>', value: 1 },
    });
    expect(result).toMatchObject({ error: expect.stringContaining('project must be one of SUP') });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('proposed');
  });
});

describe('getDecision (S2)', () => {
  it('hides readings and history of proposed tripwires from viewers who cannot edit', async () => {
    const { tripwireId, decisionId } = seedTripwire(repo, { status: 'proposed' });
    const active = seedTripwire(repo, { decisionId }).tripwireId;
    for (const id of [tripwireId, active]) {
      repo.tripwires.set(id, { ...repo.tripwires.get(id)!, lastValue: 42, lastOutcome: 'tripped', lastEvaluatedAt: '2026-11-01T00:00:00.000Z' });
      await repo.insertEvaluation({ id: `ev-${id}`, tripwireId: id, value: 42, outcome: 'tripped', evaluatedAt: '2026-11-01T00:00:00.000Z' });
    }
    const pageId = repo.decisions.get(decisionId)!.pageId;
    type View = { canEdit: boolean; assumptions: { tripwire: { id: string; lastValue: number | null }; evaluations: unknown[] }[] };
    const find = (v: View, id: string) => v.assumptions.find((a) => a.tripwire.id === id)!;

    forge.canEditPage.mockResolvedValue(false);
    const viewer = (await call('getDecision', pageId)) as unknown as View;
    expect(viewer.canEdit).toBe(false);
    expect(find(viewer, tripwireId)).toMatchObject({ tripwire: { lastValue: null, lastOutcome: null }, evaluations: [] });
    expect(find(viewer, active)).toMatchObject({ tripwire: { lastValue: 42 } });
    expect(find(viewer, active).evaluations).toHaveLength(1);

    forge.canEditPage.mockResolvedValue(true);
    const editor = (await call('getDecision', pageId)) as unknown as View;
    expect(editor.canEdit).toBe(true);
    expect(find(editor, tripwireId)).toMatchObject({ tripwire: { lastValue: 42 } });
  });
});

describe('evaluateBatch 429 re-queue (R6)', () => {
  const limited = () => new EvaluationRateLimitedError(['t2', 't3'], []);

  it('re-queues the remaining ids with attempt + 1', async () => {
    forge.evaluateMany.mockRejectedValue(limited());
    await evaluateBatch({ body: { tripwireIds: ['t1', 't2', 't3'] } });
    expect(forge.push).toHaveBeenCalledWith([{ body: { tripwireIds: ['t2', 't3'], attempt: 2 }, delayInSeconds: 60 }]);
  });

  it(`stops re-queueing after ${3} attempts`, async () => {
    expect(MAX_EVALUATE_ATTEMPTS).toBe(3);
    forge.evaluateMany.mockRejectedValue(limited());
    await evaluateBatch({ body: { tripwireIds: ['t2', 't3'], attempt: MAX_EVALUATE_ATTEMPTS } });
    expect(forge.push).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('giving up'), expect.objectContaining({ attempt: 3 }));
  });
});

describe('retryLater', () => {
  it('always sends retryData: the Forge runtime fails with ERR_INVALID_ARG_TYPE when it is undefined', () => {
    const { options } = retryLater(30, 'locked') as unknown as { options: { retryAfter: number; retryData?: unknown } };
    expect(options.retryAfter).toBe(30);
    expect(options.retryData).toEqual({ reason: 'locked' });
    expect((retryLater(60) as unknown as { options: { retryData?: unknown } }).options.retryData).toBeDefined();
  });
});

describe('reaffirmRevisit resolver', () => {
  const panel = (payload: unknown, extra: Record<string, unknown> = {}) => {
    const fn = forge.defs.get('reaffirmRevisit')!;
    return fn({
      payload,
      context: { moduleKey: 'tripwire-revisit', accountId: 'owner-1', extension: { issue: { key: 'SUP-38' } }, ...extra },
    }) as Promise<Record<string, unknown>>;
  };

  it('takes the issue key from the panel context, never from the payload', async () => {
    const a = seedTripwire(repo, { status: 'revisiting' });
    const b = seedTripwire(repo, { status: 'revisiting' });
    await repo.insertRevisit({ id: 'rv-a', decisionId: a.decisionId, issueKey: 'SUP-38', tripwireId: a.tripwireId, status: 'open' });
    await repo.insertRevisit({ id: 'rv-b', decisionId: b.decisionId, issueKey: 'SUP-77', tripwireId: b.tripwireId, status: 'open' });
    const result = await panel({ newThreshold: 45, issueKey: 'SUP-77' });
    expect(result).toMatchObject({ reaffirmed: true, issueKey: 'SUP-38' });
    expect(repo.revisits.get('rv-a')?.status).toBe('closed');
    expect(repo.revisits.get('rv-b')?.status).toBe('open');
  });

  it('refuses outside the Jira issue panel', async () => {
    expect(await panel({ newThreshold: 45 }, { moduleKey: 'tripwire-byline' })).toEqual({ error: 'Reaffirm is only available on a Jira work item.' });
  });

  it('checks page edit access as the user, owner included', async () => {
    const a = seedTripwire(repo, { status: 'revisiting' });
    await repo.insertRevisit({ id: 'rv-a', decisionId: a.decisionId, issueKey: 'SUP-38', tripwireId: a.tripwireId, status: 'open' });
    forge.canEditPage.mockResolvedValue(false);
    for (const accountId of ['owner-1', 'someone-else']) {
      expect(await panel({ newThreshold: 45 }, { accountId })).toEqual({ error: 'Only people who can edit the decision page can reaffirm it.' });
    }
    expect(forge.canEditPage).toHaveBeenCalledWith(repo.decisions.get(a.decisionId)!.pageId);
    expect(repo.revisits.get('rv-a')?.status).toBe('open');
  });
});

describe('getRevisit resolver (W1)', () => {
  const panel = () =>
    forge.defs.get('getRevisit')!({ context: { moduleKey: 'tripwire-revisit', accountId: 'user-1', extension: { issue: { key: 'SUP-38' } } } }) as Promise<
      Record<string, unknown>
    >;
  const withRevisit = async () => {
    const a = seedTripwire(repo, { status: 'revisiting', quote: 'secret quote from the page' });
    await repo.insertEvaluation({ id: 'ev-1', tripwireId: a.tripwireId, value: 37, outcome: 'tripped', evaluatedAt: '2026-11-01T00:00:00.000Z' });
    await repo.insertRevisit({ id: 'rv-a', decisionId: a.decisionId, issueKey: 'SUP-38', tripwireId: a.tripwireId, status: 'open' });
    return { ...a, pageId: repo.decisions.get(a.decisionId)!.pageId };
  };
  const expectRedacted = (result: Record<string, unknown>) => {
    expect(result).toEqual({ restricted: true, message: "You don't have access to the decision page.", revisit: { issueKey: 'SUP-38', status: 'open', createdAt: expect.any(String) } });
    const json = JSON.stringify(result);
    for (const leak of ['secret quote', 'project = SUP', 'Defer CSV export', 'https://']) expect(json).not.toContain(leak);
  };

  it('shows decision, assumption, tripwire, evaluations and the page link to people who can view the page', async () => {
    const { pageId } = await withRevisit();
    const result = await panel();
    expect(forge.viewPageAsUser).toHaveBeenCalledWith(pageId);
    expect(result).toMatchObject({ assumption: { quote: 'secret quote from the page' }, pageUrl: 'https://site/wiki/pages/1', evaluations: [{ id: 'ev-1' }] });
  });

  it('redacts everything from the page when the user cannot view it', async () => {
    await withRevisit();
    forge.viewPageAsUser.mockResolvedValue(undefined);
    expectRedacted(await panel());
  });

  it('fails closed when the access check errors', async () => {
    await withRevisit();
    forge.viewPageAsUser.mockRejectedValue(new Error('Confluence 500'));
    expectRedacted(await panel());
  });

  it('lets the consent prompt through', async () => {
    await withRevisit();
    forge.viewPageAsUser.mockRejectedValue(Object.assign(new Error('needs auth'), { name: 'NeedsAuthenticationError' }));
    await expect(panel()).rejects.toThrow('needs auth');
  });
});
