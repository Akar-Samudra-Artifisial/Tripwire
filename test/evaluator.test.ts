import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JiraError } from '../src/adapters/jira';
import { BATCH_SIZE, chunk, EvaluationRateLimitedError, evaluateMany, evaluateOne, type EvalDeps } from '../src/core/evaluator';
import { thresholdOutcome } from '../src/core/triggers/common';
import type { JqlThresholdSpec, TriggerReading } from '../src/core/types';
import { fakeRepo, type FakeRepo } from './helpers/fakeRepo';
import { seedTripwire } from './helpers/seed';

let repo: FakeRepo;
let count: number;
let clock: number;
const openRevisit = vi.fn<(id: string) => Promise<unknown>>();
const jqlReader = vi.fn<(spec: JqlThresholdSpec) => Promise<TriggerReading>>();
let deps: EvalDeps;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  repo = fakeRepo();
  repo.settings = { ...repo.settings, allowedProjectKeys: ['SUP'] };
  count = 7;
  clock = Date.parse('2026-11-02T09:00:00Z');
  openRevisit.mockReset().mockResolvedValue(undefined);
  jqlReader.mockReset().mockImplementation(async (spec) => ({ value: count, outcome: thresholdOutcome(count, spec.op, spec.value) }));
  deps = {
    repo,
    readers: {
      jql_threshold: jqlReader,
      date: vi.fn(),
      checkin: vi.fn(),
      content_change: vi.fn(),
    },
    openRevisit,
    now: () => new Date((clock += 86_400_000)),
  };
});

describe('evaluateOne', () => {
  it('7 / > 10 stays active and records one evaluation', async () => {
    const { tripwireId } = seedTripwire(repo);
    const result = await evaluateOne(tripwireId, deps);
    expect(result).toMatchObject({ status: 'evaluated', outcome: 'safe', value: 7, newStatus: 'active', revisitRequested: false });
    expect(repo.evaluations).toHaveLength(1);
    expect(repo.evaluations[0]).toMatchObject({ tripwireId, value: 7, outcome: 'safe' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', strikes: 0, lastValue: 7, lastOutcome: 'safe' });
    expect(repo.tripwires.get(tripwireId)?.lastEvaluatedAt).toBeTruthy();
  });

  it('8 / > 10 becomes near', async () => {
    const { tripwireId } = seedTripwire(repo);
    count = 8;
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'near', newStatus: 'near' });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('near');
  });

  it('11 once is a single strike: near, no Revisit', async () => {
    const { tripwireId } = seedTripwire(repo);
    count = 11;
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'tripped', newStatus: 'near' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'near', strikes: 1 });
    expect(openRevisit).not.toHaveBeenCalled();
  });

  it('11 twice trips and asks for a Revisit once', async () => {
    const { tripwireId } = seedTripwire(repo);
    count = 11;
    await evaluateOne(tripwireId, deps);
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ newStatus: 'tripped', revisitRequested: true });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'tripped', strikes: 2 });
    expect(openRevisit).toHaveBeenCalledTimes(1);
    expect(openRevisit).toHaveBeenCalledWith(tripwireId);
  });

  it('revisiting + 37 records the evaluation but keeps the status and opens nothing', async () => {
    const { tripwireId, decisionId } = seedTripwire(repo, { status: 'revisiting', strikes: 2 });
    await repo.insertRevisit({ id: 'rv-1', decisionId, tripwireId, issueKey: 'SUP-9', status: 'open' });
    count = 37;
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ status: 'evaluated', newStatus: 'revisiting', revisitRequested: false });
    expect(repo.evaluations).toHaveLength(1);
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'revisiting', strikes: 3, lastValue: 37 });
    expect(openRevisit).not.toHaveBeenCalled();
  });

  it('tripped + 37 asks for the Revisit again (retry after a failed open)', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    count = 37;
    await evaluateOne(tripwireId, deps);
    expect(openRevisit).toHaveBeenCalledTimes(1);
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'tripped', strikes: 3 });
  });

  it('tripped + 5 goes back to active with zero strikes', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    count = 5;
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ newStatus: 'active' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', strikes: 0 });
    expect(openRevisit).not.toHaveBeenCalled();
  });

  it('a failing reader returns error and writes nothing', async () => {
    const { tripwireId } = seedTripwire(repo);
    jqlReader.mockRejectedValueOnce(new JiraError(400, 'Jira 400: bad JQL'));
    expect(await evaluateOne(tripwireId, deps)).toEqual({ status: 'error', tripwireId, message: 'Jira 400: bad JQL' });
    expect(repo.evaluations).toEqual([]);
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', lastValue: null, lastEvaluatedAt: null });
  });

  it('a lost CAS is reported as concurrent', async () => {
    const { tripwireId } = seedTripwire(repo);
    vi.spyOn(repo, 'casTripwire').mockResolvedValueOnce(false);
    expect(await evaluateOne(tripwireId, deps)).toEqual({ status: 'skipped', tripwireId, reason: 'concurrent' });
    expect(openRevisit).not.toHaveBeenCalled();
  });

  it('a lost CAS leaves no evaluation row behind (R5)', async () => {
    const { tripwireId } = seedTripwire(repo);
    vi.spyOn(repo, 'casTripwire').mockResolvedValueOnce(false);
    await evaluateOne(tripwireId, deps);
    expect(repo.evaluations).toEqual([]);
  });

  it('CAS also matches strikes: a concurrent strike makes this run concurrent (R5)', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'near', strikes: 1 });
    count = 37;
    jqlReader.mockImplementationOnce(async (spec) => {
      // Another run records its strike while this one is still reading Jira.
      repo.tripwires.set(tripwireId, { ...repo.tripwires.get(tripwireId)!, strikes: 2, status: 'near' });
      return { value: count, outcome: thresholdOutcome(count, spec.op, spec.value) };
    });
    expect(await evaluateOne(tripwireId, deps)).toEqual({ status: 'skipped', tripwireId, reason: 'concurrent' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'near', strikes: 2 });
    expect(repo.evaluations).toEqual([]);
    expect(openRevisit).not.toHaveBeenCalled();
  });

  it('two evaluations in the same second both count as one changed row each (R5)', async () => {
    const { tripwireId } = seedTripwire(repo);
    deps.now = () => new Date('2026-11-02T09:00:00Z');
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ status: 'evaluated' });
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ status: 'evaluated' });
    expect(repo.versions.get(tripwireId)).toBe(2);
  });

  it('a failed evaluation insert still moves the state and asks for the Revisit (R5)', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    count = 37;
    vi.spyOn(repo, 'insertEvaluation').mockRejectedValueOnce(new Error('sql down'));
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ status: 'evaluated', newStatus: 'tripped' });
    expect(openRevisit).toHaveBeenCalledTimes(1);
  });

  it('re-checks the JQL against the allowed projects before counting (S1)', async () => {
    const { tripwireId } = seedTripwire(repo);
    repo.settings = { ...repo.settings, allowedProjectKeys: ['OPS'] };
    const result = await evaluateOne(tripwireId, deps);
    expect(result).toMatchObject({ status: 'error', tripwireId });
    expect(result.status === 'error' ? result.message : '').toContain('jql not allowed');
    expect(jqlReader).not.toHaveBeenCalled();
    expect(repo.evaluations).toEqual([]);
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', strikes: 0, lastValue: null });
  });

  it('a revisiting tripwire without an open revisit goes back through tripped and retries the Revisit (R2)', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'revisiting', strikes: 2 });
    count = 37;
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ status: 'evaluated', newStatus: 'tripped', revisitRequested: true });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'tripped', strikes: 3 });
    expect(openRevisit).toHaveBeenCalledWith(tripwireId);
  });

  it('skips proposed, unknown and graph_relation tripwires', async () => {
    const proposed = seedTripwire(repo, { status: 'proposed' }).tripwireId;
    const graph = seedTripwire(repo).tripwireId;
    repo.tripwires.set(graph, { ...repo.tripwires.get(graph)!, kind: 'graph_relation', spec: { anchor: 'x', relation: 'teams', op: '>', value: 1 } });
    expect(await evaluateOne(proposed, deps)).toEqual({ status: 'skipped', tripwireId: proposed, reason: 'not_evaluable' });
    expect(await evaluateOne('missing', deps)).toEqual({ status: 'skipped', tripwireId: 'missing', reason: 'not_found' });
    expect(await evaluateOne(graph, deps)).toEqual({ status: 'skipped', tripwireId: graph, reason: 'kind_not_supported' });
    expect(repo.evaluations).toEqual([]);
  });

  it('passes confirmedAt to checkin and baselineVersion to content_change readers', async () => {
    const c = seedTripwire(repo).tripwireId;
    repo.tripwires.set(c, { ...repo.tripwires.get(c)!, kind: 'checkin', spec: { every: 'quarter', question: 'Still true?' } });
    const p = seedTripwire(repo).tripwireId;
    repo.tripwires.set(p, { ...repo.tripwires.get(p)!, kind: 'content_change', spec: { pageId: '1', watch: 'any_edit' }, baselineVersion: 4 });
    vi.mocked(deps.readers.checkin).mockResolvedValue({ value: null, outcome: 'safe' });
    vi.mocked(deps.readers.content_change).mockResolvedValue({ value: 4, outcome: 'safe' });
    await evaluateMany([c, p], deps);
    expect(deps.readers.checkin).toHaveBeenCalledWith({ every: 'quarter', question: 'Still true?' }, '2026-10-01T00:00:00.000Z', expect.any(Date));
    expect(deps.readers.content_change).toHaveBeenCalledWith({ pageId: '1', watch: 'any_edit' }, 4);
  });
});

describe('listEvaluations', () => {
  it('orders evaluations with the same timestamp by id, newest id first (R8)', async () => {
    for (const id of ['e-a', 'e-c', 'e-b']) {
      await repo.insertEvaluation({ id, tripwireId: 't', value: 1, outcome: 'safe', evaluatedAt: '2026-11-02T09:00:00.000Z' });
    }
    expect((await repo.listEvaluations('t', 10)).map((e) => e.id)).toEqual(['e-c', 'e-b', 'e-a']);
  });
});

describe('evaluateMany', () => {
  it('loads settings once for the whole batch', async () => {
    const ids = [seedTripwire(repo).tripwireId, seedTripwire(repo).tripwireId];
    const spy = vi.spyOn(repo, 'getSettings');
    await evaluateMany(ids, deps);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stops on a Jira 429 and reports the ids still to evaluate', async () => {
    const ids = [seedTripwire(repo).tripwireId, seedTripwire(repo).tripwireId, seedTripwire(repo).tripwireId];
    jqlReader
      .mockImplementationOnce(async () => ({ value: 7, outcome: 'safe' }))
      .mockRejectedValueOnce(new JiraError(429, 'Jira 429: rate limited'));
    const err = await evaluateMany(ids, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvaluationRateLimitedError);
    expect((err as EvaluationRateLimitedError).remaining).toEqual(ids.slice(1));
    expect((err as EvaluationRateLimitedError).done).toHaveLength(1);
    expect(repo.evaluations).toHaveLength(1);
  });
});

describe('chunk', () => {
  it('splits 45 ids into 3 batches of BATCH_SIZE', () => {
    const batches = chunk(Array.from({ length: 45 }, (_, i) => `id-${i}`), BATCH_SIZE);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
  });
});
