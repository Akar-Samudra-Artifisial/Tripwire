import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

const { evaluateOne } = await import('../src/core/evaluator');
const { MAX_THRESHOLD, openRevisit, parseThreshold, reaffirmRevisit, suggestThreshold } = await import('../src/core/revisit');
const { thresholdOutcome } = await import('../src/core/triggers/common');
const { fakeRepo } = await import('./helpers/fakeRepo');
const { seedTripwire } = await import('./helpers/seed');

import type { EvalDeps } from '../src/core/evaluator';
import type { ReaffirmDeps } from '../src/core/revisit';
import type { JqlThresholdSpec } from '../src/core/types';
import type { FakeRepo } from './helpers/fakeRepo';

const OWNER = 'owner-1';
const EDITOR = 'editor-2';
const STRANGER = 'stranger-3';

let repo: FakeRepo;
const transitionToDone = vi.fn<ReaffirmDeps['jira']['transitionToDone']>();
const addComment = vi.fn<ReaffirmDeps['jira']['addComment']>();
const canEditPage = vi.fn<ReaffirmDeps['canEditPage']>();
let deps: ReaffirmDeps;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  repo = fakeRepo();
  repo.settings = { ...repo.settings, revisitProjectKey: 'SUP', allowedProjectKeys: ['SUP'] };
  transitionToDone.mockReset().mockResolvedValue('Done');
  addComment.mockReset().mockResolvedValue(undefined);
  canEditPage.mockReset().mockResolvedValue(true);
  deps = { repo, jira: { transitionToDone, addComment }, canEditPage };
});

/** Demo state after Simulate: tripwire `> 10` revisiting at 37 with an open Revisit SUP-38. */
async function revisiting() {
  const seeded = seedTripwire(repo, { status: 'revisiting', strikes: 2 });
  repo.tripwires.set(seeded.tripwireId, { ...repo.tripwires.get(seeded.tripwireId)!, lastValue: 37, lastOutcome: 'tripped', lastEvaluatedAt: '2026-11-02T09:00:00.000Z' });
  await repo.insertRevisit({ id: 'rv-1', decisionId: seeded.decisionId, issueKey: 'SUP-38', tripwireId: seeded.tripwireId, status: 'open' });
  return seeded;
}

describe('parseThreshold / suggestThreshold', () => {
  it('accepts finite numbers in range and numeric strings', () => {
    expect(parseThreshold(45)).toEqual({ ok: true, value: 45 });
    expect(parseThreshold('45')).toEqual({ ok: true, value: 45 });
    expect(parseThreshold(0)).toEqual({ ok: true, value: 0 });
  });

  it('rejects non-numbers, negatives, NaN, Infinity and absurd values', () => {
    for (const bad of [undefined, null, '', 'abc', NaN, Infinity, -1, MAX_THRESHOLD + 1, {}, [45]]) {
      expect(parseThreshold(bad)).toMatchObject({ ok: false });
    }
  });

  it('suggests 20% above the last reading, rounded up', () => {
    expect(suggestThreshold(37, 10)).toBe(45);
    expect(suggestThreshold(1, 0)).toBe(2);
    expect(suggestThreshold(null, 10)).toBe(10);
  });
});

describe('reaffirmRevisit', () => {
  it('an editor reaffirms: new threshold, active, strikes 0, lastOutcome cleared, revisit closed, issue Done + plain comment', async () => {
    const { tripwireId, decisionId } = await revisiting();
    const result = await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45, note: 'Spike from one campaign' }, deps);

    expect(result).toEqual({ reaffirmed: true, issueKey: 'SUP-38', oldThreshold: 10, newThreshold: 45, status: 'active', warnings: [] });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', strikes: 0, spec: { op: '>', value: 45 }, lastValue: 37, lastOutcome: null });
    expect(repo.revisits.get('rv-1')).toMatchObject({ status: 'closed', outcome: 'reaffirm', resolvedBy: OWNER, newThreshold: 45 });
    expect(repo.revisits.get('rv-1')?.resolvedAt).toBeTruthy();
    expect(canEditPage).toHaveBeenCalledWith(repo.decisions.get(decisionId)?.pageId);
    expect(transitionToDone).toHaveBeenCalledWith('SUP-38');
    const comment = JSON.stringify(addComment.mock.calls[0]?.[1]);
    expect(comment).toContain('threshold 10 → 45');
    expect(comment).toContain('Note: Spike from one campaign');
    expect(comment).not.toContain('mention');
    expect(comment).not.toContain(OWNER);
  });

  it('a page editor who is not the owner may reaffirm', async () => {
    await revisiting();
    expect(await reaffirmRevisit('SUP-38', EDITOR, { newThreshold: 45 }, deps)).toMatchObject({ reaffirmed: true });
  });

  it('refuses people who cannot edit the page, the decision owner included, and changes nothing', async () => {
    const { tripwireId } = await revisiting();
    canEditPage.mockResolvedValue(false);
    for (const user of [OWNER, STRANGER]) {
      expect(await reaffirmRevisit('SUP-38', user, { newThreshold: 45 }, deps)).toEqual({ error: 'Only people who can edit the decision page can reaffirm it.' });
    }
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'revisiting', spec: { value: 10 } });
    expect(repo.revisits.get('rv-1')?.status).toBe('open');
    expect(transitionToDone).not.toHaveBeenCalled();
  });

  it('rejects an invalid threshold without changing anything', async () => {
    const { tripwireId } = await revisiting();
    expect(await reaffirmRevisit('SUP-38', OWNER, { newThreshold: -3 }, deps)).toMatchObject({ error: expect.stringContaining('between 0') });
    expect(await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 'lots' }, deps)).toMatchObject({ error: 'New threshold must be a number.' });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('revisiting');
  });

  it('is idempotent: two parallel clicks resolve once, the other gets "already resolved"', async () => {
    await revisiting();
    const results = await Promise.all([
      reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps),
      reaffirmRevisit('SUP-38', OWNER, { newThreshold: 50 }, deps),
    ]);
    expect(results.filter((r) => 'reaffirmed' in r)).toHaveLength(1);
    expect(results.filter((r) => 'error' in r)).toEqual([{ error: 'already resolved' }]);
    expect(transitionToDone).toHaveBeenCalledTimes(1);
    expect(addComment).toHaveBeenCalledTimes(1);
    const winner = results.find((r) => 'reaffirmed' in r) as { newThreshold: number };
    expect(await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps)).toEqual({
      error: `already resolved: the decision was reaffirmed with threshold ${winner.newThreshold}.`,
    });
  });

  it('closed revisits say how they were resolved', async () => {
    const { tripwireId, decisionId } = await revisiting();
    await repo.insertRevisit({ id: 'rv-2', decisionId, issueKey: 'SUP-39', tripwireId, status: 'closed', outcome: 'supersede' });
    await repo.insertRevisit({ id: 'rv-3', decisionId, issueKey: 'SUP-40', tripwireId, status: 'closed' });
    expect(await reaffirmRevisit('SUP-39', OWNER, { newThreshold: 45 }, deps)).toEqual({ error: 'already resolved: the decision was superseded.' });
    expect(await reaffirmRevisit('SUP-40', OWNER, { newThreshold: 45 }, deps)).toEqual({ error: 'already resolved: this revisit was closed.' });
  });

  it('when another request closed the revisit between the CAS and the close, rolls the tripwire back', async () => {
    const { tripwireId } = await revisiting();
    repo.closeRevisit = vi.fn().mockResolvedValue(false);
    expect(await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps)).toEqual({ error: 'already resolved' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'revisiting', strikes: 2, spec: { value: 10 }, lastOutcome: 'tripped' });
    expect(transitionToDone).not.toHaveBeenCalled();
  });

  it.each(['proposed', 'archived'] as const)('refuses a %s tripwire and changes nothing', async (status) => {
    const { tripwireId } = await revisiting();
    repo.tripwires.set(tripwireId, { ...repo.tripwires.get(tripwireId)!, status });
    expect(await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps)).toEqual({
      error: `This tripwire is ${status}; only a tripped tripwire under revisit can be reaffirmed.`,
    });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status, spec: { value: 10 } });
    expect(repo.revisits.get('rv-1')?.status).toBe('open');
    expect(transitionToDone).not.toHaveBeenCalled();
  });

  it('orphan: an open revisit next to an active tripwire (failed rollback) is still resolved', async () => {
    const { tripwireId } = await revisiting();
    repo.tripwires.set(tripwireId, { ...repo.tripwires.get(tripwireId)!, status: 'active', strikes: 0 });
    const result = await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps);
    expect(result).toMatchObject({ reaffirmed: true, oldThreshold: 10, newThreshold: 45, warnings: [] });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', spec: { value: 45 }, lastOutcome: null });
    expect(repo.revisits.get('rv-1')?.status).toBe('closed');
    expect(transitionToDone).toHaveBeenCalledWith('SUP-38');
  });

  it('orphan: an open revisit does not block the next trip, which re-links to it and can then be reaffirmed', async () => {
    const { tripwireId, decisionId } = await revisiting();
    repo.tripwires.set(tripwireId, { ...repo.tripwires.get(tripwireId)!, status: 'tripped' });
    const createIssue = vi.fn();
    const opened = await openRevisit(tripwireId, { repo, jira: { createIssue, getProject: vi.fn() }, now: () => new Date('2026-11-03T09:00:00Z') });
    expect(opened).toEqual({ created: false, reason: 'already_open', issueKey: 'SUP-38' });
    expect(createIssue).not.toHaveBeenCalled();
    expect(repo.tripwires.get(tripwireId)?.status).toBe('revisiting');
    expect(await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps)).toMatchObject({ reaffirmed: true });
    expect(await repo.findOpenRevisit(decisionId)).toBeUndefined();
  });

  it('a failed Jira transition is a warning, not a rollback', async () => {
    const { tripwireId } = await revisiting();
    transitionToDone.mockRejectedValue(new Error('Jira 400: transition not allowed'));
    const result = await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps);
    expect(result).toMatchObject({ reaffirmed: true, warnings: ['Could not move SUP-38 to Done: Jira 400: transition not allowed'] });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('active');
    expect(repo.revisits.get('rv-1')?.status).toBe('closed');
    expect(addComment).toHaveBeenCalled();
  });

  it('reports a workflow without a Done transition', async () => {
    await revisiting();
    transitionToDone.mockResolvedValue(undefined);
    expect(await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps)).toMatchObject({
      warnings: [expect.stringContaining('no transition to a Done status')],
    });
  });

  it('puts the tripwire back when the revisit row cannot be closed', async () => {
    const { tripwireId } = await revisiting();
    repo.closeRevisit = vi.fn().mockRejectedValue(new Error('SQL down'));
    await expect(reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps)).rejects.toThrow('SQL down');
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'revisiting', strikes: 2, spec: { value: 10 } });
  });

  it('refuses unknown issues', async () => {
    expect(await reaffirmRevisit('SUP-1', OWNER, { newThreshold: 45 }, deps)).toEqual({ error: 'This work item is not a Tripwire revisit task.' });
  });

  it('a checkin tripwire is reaffirmed without a threshold (per-kind reaffirm, see nonNumeric.test.ts)', async () => {
    const { tripwireId, decisionId } = seedTripwire(repo, { status: 'revisiting' });
    repo.tripwires.set(tripwireId, { ...repo.tripwires.get(tripwireId)!, kind: 'checkin', spec: { every: 'month', question: 'Still true?' } });
    await repo.insertRevisit({ id: 'rv-2', decisionId, issueKey: 'SUP-50', tripwireId, status: 'open' });
    expect(await reaffirmRevisit('SUP-50', OWNER, { newThreshold: 45 }, deps)).toMatchObject({ reaffirmed: true, kind: 'checkin' });
  });

  it('after reaffirming to 45, the next reading of 37 is near and opens no Revisit', async () => {
    const { tripwireId } = await revisiting();
    await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 45 }, deps);
    const openRevisit = vi.fn();
    const evalDeps: EvalDeps = {
      repo,
      readers: {
        jql_threshold: async (spec: JqlThresholdSpec) => ({ value: 37, outcome: thresholdOutcome(37, spec.op, spec.value) }),
        date: vi.fn(),
        checkin: vi.fn(),
        content_change: vi.fn(),
      },
      openRevisit,
      now: () => new Date('2026-11-03T09:00:00Z'),
    };
    const first = await evaluateOne(tripwireId, evalDeps);
    const second = await evaluateOne(tripwireId, evalDeps);
    expect(first).toMatchObject({ outcome: 'near', newStatus: 'near', revisitRequested: false });
    expect(second).toMatchObject({ outcome: 'near', newStatus: 'near', revisitRequested: false });
    expect(openRevisit).not.toHaveBeenCalled();
  });

  it('a threshold equal to the reading (37, op >) is not tripped either', async () => {
    const { tripwireId } = await revisiting();
    await reaffirmRevisit('SUP-38', OWNER, { newThreshold: 37 }, deps);
    const spec = repo.tripwires.get(tripwireId)!.spec as JqlThresholdSpec;
    expect(thresholdOutcome(37, spec.op, spec.value)).not.toBe('tripped');
  });
});
