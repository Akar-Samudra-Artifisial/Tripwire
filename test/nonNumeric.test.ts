import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

const { evaluateOne } = await import('../src/core/evaluator');
const { reaffirmRevisit } = await import('../src/core/revisit');
const { nextState, strikesToTrip, STRIKES_TO_TRIP } = await import('../src/core/state');
const checkin = await import('../src/core/triggers/checkin');
const date = await import('../src/core/triggers/date');
const { contentChangeReading } = await import('../src/core/triggers/content_change');
const { validateSpec } = await import('../src/core/triggers');
const { formatReading, describeSpec, describeValue } = await import('../src/core/describe');
const { fakeRepo } = await import('./helpers/fakeRepo');
const { seedTripwire } = await import('./helpers/seed');

import type { TripwireRow } from '../src/adapters/repo';
import type { EvalDeps } from '../src/core/evaluator';
import type { ReaffirmDeps } from '../src/core/revisit';
import type { TripwireKind } from '../src/core/types';
import type { FakeRepo } from './helpers/fakeRepo';

const DAY = 86_400_000;
const NOW = new Date('2026-11-02T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

describe('strikesToTrip / nextState per kind', () => {
  it('numeric kinds need two strikes, date/checkin/content_change one', () => {
    expect(strikesToTrip('jql_threshold')).toBe(STRIKES_TO_TRIP);
    expect(strikesToTrip('graph_relation')).toBe(2);
    for (const kind of ['date', 'checkin', 'content_change'] as const) expect(strikesToTrip(kind)).toBe(1);
  });

  it.each(['date', 'checkin', 'content_change'] as const)('%s trips on the first tripped reading', (kind) => {
    expect(nextState({ status: 'active', strikes: 0 }, 'tripped', kind)).toEqual({ status: 'tripped', strikes: 1, openRevisit: true });
    expect(nextState({ status: 'near', strikes: 0 }, 'tripped', kind)).toEqual({ status: 'tripped', strikes: 1, openRevisit: true });
  });

  it('jql_threshold still needs two (also when the kind is passed explicitly)', () => {
    expect(nextState({ status: 'active', strikes: 0 }, 'tripped', 'jql_threshold')).toEqual({ status: 'near', strikes: 1, openRevisit: false });
    expect(nextState({ status: 'active', strikes: 0 }, 'tripped')).toEqual({ status: 'near', strikes: 1, openRevisit: false });
  });
});

describe('date trigger', () => {
  it('today+3 with a 30 day lead is near; today and yesterday are tripped; far away is safe', async () => {
    expect(await date.evaluate({ date: '2026-11-05', leadDays: 30 }, NOW)).toMatchObject({ outcome: 'near', value: 3 });
    expect(await date.evaluate({ date: '2026-11-02', leadDays: 30 }, NOW)).toMatchObject({ outcome: 'tripped', value: 0 });
    expect(await date.evaluate({ date: '2026-11-01', leadDays: 30 }, NOW)).toMatchObject({ outcome: 'tripped', value: -1, detail: '1 days past 2026-11-01' });
    expect(await date.evaluate({ date: '2027-03-31', leadDays: 30 }, NOW)).toMatchObject({ outcome: 'safe' });
  });

  it('a resolved (handled) date stays safe, and validation keeps the flag', async () => {
    expect(await date.evaluate({ date: '2026-11-01', leadDays: 30, resolved: true }, NOW)).toMatchObject({ outcome: 'safe', value: -1 });
    expect(validateSpec('date', { date: '2026-11-01', leadDays: 3, resolved: true })).toEqual({
      ok: true,
      spec: { date: '2026-11-01', leadDays: 3, resolved: true },
    });
    expect(validateSpec('date', { date: '2026-11-01', leadDays: 3, resolved: 'yes' }).ok).toBe(false);
  });
});

describe('checkin trigger', () => {
  const spec = { every: 'month' as const, question: 'Still true?' };

  it('counts days left in the period: safe, near in the last 7 days, tripped once overdue', async () => {
    expect(await checkin.evaluate(spec, daysAgo(10), NOW)).toMatchObject({ outcome: 'safe', value: 20 });
    expect(await checkin.evaluate(spec, daysAgo(23), NOW)).toMatchObject({ outcome: 'near', value: 7 });
    expect(await checkin.evaluate(spec, daysAgo(30), NOW)).toMatchObject({ outcome: 'tripped', value: 0 });
    expect(await checkin.evaluate(spec, daysAgo(31), NOW)).toMatchObject({ outcome: 'tripped', value: -1 });
    expect(await checkin.evaluate({ ...spec, every: 'quarter' }, daysAgo(31), NOW)).toMatchObject({ outcome: 'safe', value: 60 });
  });

  it('never answered: the period starts now, so it never trips at once', async () => {
    expect(await checkin.evaluate(spec, undefined, NOW)).toMatchObject({ outcome: 'safe', value: 30 });
  });
});

describe('content_change trigger', () => {
  it('no baseline is safe; same version safe; a newer version trips', () => {
    expect(contentChangeReading(5)).toMatchObject({ outcome: 'safe', value: 5 });
    expect(contentChangeReading(5, 5)).toMatchObject({ outcome: 'safe' });
    expect(contentChangeReading(6, 5)).toMatchObject({ outcome: 'tripped', value: 6 });
  });
});

describe('describeValue (Trend lines)', () => {
  it('describes past readings in words instead of raw numbers like -1', () => {
    expect(describeValue('date', { date: '2026-11-01', leadDays: 30 }, -1)).toBe('1 day past 2026-11-01');
    expect(describeValue('date', { date: '2026-11-01', leadDays: 30, resolved: true }, -1)).toBe('1 day past 2026-11-01');
    expect(describeValue('jql_threshold', { jql: 'x', op: '>', value: 10 }, 37)).toBe('37');
    expect(describeValue('checkin', { every: 'quarter', question: 'q' }, null)).toBe('—');
    expect(describeValue('checkin', { every: 'quarter', question: 'q' }, 3)).not.toBe('3');
    expect(describeValue('content_change', { pageId: '1', watch: 'any_edit' }, 6)).not.toBe('6');
  });
});

describe('formatReading / describeSpec for non-numeric kinds', () => {
  const t = (kind: TripwireKind, spec: unknown, lastValue: number | null, extra: object = {}) => ({
    kind,
    spec,
    lastValue,
    lastEvaluatedAt: '2026-11-02T09:00:00.000Z',
    ...extra,
  });

  it('date', () => {
    expect(formatReading(t('date', { date: '2026-11-05', leadDays: 30 }, 3))).toBe('3 days left until 2026-11-05 (measured 2026-11-02)');
    expect(formatReading(t('date', { date: '2026-11-01', leadDays: 30 }, -1))).toBe('1 day past 2026-11-01 (measured 2026-11-02)');
    expect(formatReading(t('date', { date: '2026-11-01', leadDays: 30, resolved: true }, -1))).toBe('2026-11-01 handled (measured 2026-11-02)');
    expect(describeSpec('date', { date: '2026-11-01', leadDays: 30, resolved: true })).toContain('handled');
  });

  it('checkin', () => {
    expect(formatReading(t('checkin', {}, 5))).toBe('next check-in due in 5 days (measured 2026-11-02)');
    expect(formatReading(t('checkin', {}, -1))).toBe('check-in overdue by 1 day (measured 2026-11-02)');
    expect(formatReading(t('checkin', {}, null, { confirmedAt: '2026-10-01T00:00:00.000Z' }))).toBe('last answered 2026-10-01');
  });

  it('content_change and the numeric format stays the same', () => {
    expect(formatReading(t('content_change', {}, 6, { baselineVersion: 5 }))).toBe('page edited: version 6 (accepted 5) (measured 2026-11-02)');
    expect(formatReading(t('content_change', {}, 5, { baselineVersion: 5 }))).toBe('page version 5, unchanged (measured 2026-11-02)');
    expect(formatReading(t('jql_threshold', { op: '>', value: 10 }, 37))).toBe('37 (measured 2026-11-02) · threshold > 10');
  });
});

let repo: FakeRepo;

function asKind(id: string, patch: Partial<TripwireRow>) {
  repo.tripwires.set(id, { ...repo.tripwires.get(id)!, ...patch });
}

describe('evaluateOne for non-numeric kinds', () => {
  const openRevisit = vi.fn<(id: string) => Promise<unknown>>();
  let deps: EvalDeps;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    repo = fakeRepo();
    openRevisit.mockReset().mockResolvedValue(undefined);
    deps = {
      repo,
      readers: { jql_threshold: vi.fn(), date: date.evaluate, checkin: checkin.evaluate, content_change: vi.fn() },
      openRevisit,
      now: () => NOW,
    };
  });

  it('a passed date trips and asks for a Revisit in one evaluation', async () => {
    const { tripwireId } = seedTripwire(repo);
    asKind(tripwireId, { kind: 'date', spec: { date: '2026-11-01', leadDays: 30 } });
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'tripped', newStatus: 'tripped', revisitRequested: true });
    expect(openRevisit).toHaveBeenCalledWith(tripwireId);
  });

  it('a date three days ahead is near, no Revisit', async () => {
    const { tripwireId } = seedTripwire(repo);
    asKind(tripwireId, { kind: 'date', spec: { date: '2026-11-05', leadDays: 30 } });
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'near', value: 3, newStatus: 'near', revisitRequested: false });
  });

  it('an overdue check-in trips in one evaluation', async () => {
    const { tripwireId } = seedTripwire(repo);
    asKind(tripwireId, { kind: 'checkin', spec: { every: 'month', question: 'Still true?' }, confirmedAt: daysAgo(31) });
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'tripped', newStatus: 'tripped', revisitRequested: true });
  });

  it('a check-in without confirmedAt is safe and starts its period now', async () => {
    const { tripwireId } = seedTripwire(repo);
    asKind(tripwireId, { kind: 'checkin', spec: { every: 'month', question: 'Still true?' }, confirmedAt: undefined });
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'safe', newStatus: 'active' });
    expect(repo.tripwires.get(tripwireId)?.confirmedAt).toBe(NOW.toISOString());
  });

  it('content_change without a baseline stores the version read; a later edit trips once', async () => {
    const { tripwireId } = seedTripwire(repo);
    asKind(tripwireId, { kind: 'content_change', spec: { pageId: '1', watch: 'any_edit' }, baselineVersion: null });
    let version = 4;
    deps.readers.content_change = async (_spec, baseline) => contentChangeReading(version, baseline);
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'safe', newStatus: 'active' });
    expect(repo.tripwires.get(tripwireId)?.baselineVersion).toBe(4);
    version = 5;
    expect(await evaluateOne(tripwireId, deps)).toMatchObject({ outcome: 'tripped', newStatus: 'tripped', revisitRequested: true });
    expect(repo.tripwires.get(tripwireId)?.baselineVersion).toBe(4);
  });

  it('content_change: a reading against a baseline moved meanwhile (demo note, Accept) does not count', async () => {
    const { tripwireId } = seedTripwire(repo);
    asKind(tripwireId, { kind: 'content_change', spec: { pageId: '1', watch: 'any_edit' }, baselineVersion: 3 });
    deps.readers.content_change = async (_spec, baseline) => {
      // The demo review note moved the baseline to 4 while the page (already at 4) was read.
      asKind(tripwireId, { baselineVersion: 4 });
      return contentChangeReading(4, baseline);
    };
    expect(await evaluateOne(tripwireId, deps)).toEqual({ status: 'skipped', tripwireId, reason: 'concurrent' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', baselineVersion: 4 });
    expect(openRevisit).not.toHaveBeenCalled();
  });
});

describe('reaffirmRevisit per kind', () => {
  const transitionToDone = vi.fn<ReaffirmDeps['jira']['transitionToDone']>();
  const addComment = vi.fn<ReaffirmDeps['jira']['addComment']>();
  const canEditPage = vi.fn<ReaffirmDeps['canEditPage']>();
  const pageVersion = vi.fn<(pageId: string) => Promise<number>>();
  let deps: ReaffirmDeps;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    repo = fakeRepo();
    transitionToDone.mockReset().mockResolvedValue('Done');
    addComment.mockReset().mockResolvedValue(undefined);
    canEditPage.mockReset().mockResolvedValue(true);
    pageVersion.mockReset().mockResolvedValue(9);
    deps = { repo, jira: { transitionToDone, addComment }, canEditPage, pageVersion, now: () => NOW };
  });

  async function revisitingAs(patch: Partial<TripwireRow>) {
    const seeded = seedTripwire(repo, { status: 'revisiting', strikes: 1 });
    asKind(seeded.tripwireId, { lastOutcome: 'tripped', ...patch });
    await repo.insertRevisit({ id: 'rv-k', decisionId: seeded.decisionId, issueKey: 'SUP-70', tripwireId: seeded.tripwireId, status: 'open' });
    return seeded;
  }

  it('checkin "Still true": answered now, active, strikes 0, revisit closed without threshold, plain comment', async () => {
    const { tripwireId } = await revisitingAs({ kind: 'checkin', spec: { every: 'month', question: 'Still true?' }, confirmedAt: daysAgo(31), lastValue: -1 });
    const result = await reaffirmRevisit('SUP-70', 'owner-1', { note: 'Checked with CS' }, deps);
    expect(result).toMatchObject({ reaffirmed: true, issueKey: 'SUP-70', kind: 'checkin', status: 'active', warnings: [] });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', strikes: 0, confirmedAt: NOW.toISOString(), lastValue: 30, lastOutcome: null });
    const revisit = repo.revisits.get('rv-k');
    expect(revisit).toMatchObject({ status: 'closed', outcome: 'reaffirm' });
    expect(revisit?.newThreshold).toBeUndefined();
    const comment = JSON.stringify(addComment.mock.calls[0]?.[1]);
    expect(comment).toContain('still true');
    expect(comment).toContain('Note: Checked with CS');
    // The next evaluation is safe again.
    const evalDeps: EvalDeps = {
      repo,
      readers: { jql_threshold: vi.fn(), date: vi.fn(), checkin: checkin.evaluate, content_change: vi.fn() },
      openRevisit: vi.fn(),
      now: () => new Date(NOW.getTime() + DAY),
    };
    expect(await evaluateOne(tripwireId, evalDeps)).toMatchObject({ outcome: 'safe', newStatus: 'active' });
  });

  it('content_change: the current page version becomes the baseline', async () => {
    const { tripwireId, decisionId } = await revisitingAs({ kind: 'content_change', spec: { pageId: '1', watch: 'any_edit' }, baselineVersion: 4, lastValue: 6 });
    expect(await reaffirmRevisit('SUP-70', 'owner-1', {}, deps)).toMatchObject({ reaffirmed: true, kind: 'content_change' });
    expect(pageVersion).toHaveBeenCalledWith(repo.decisions.get(decisionId)?.pageId);
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', strikes: 0, baselineVersion: 9, lastValue: 9 });
  });

  it('content_change falls back to the last reading when the page version cannot be read', async () => {
    const { tripwireId } = await revisitingAs({ kind: 'content_change', spec: { pageId: '1', watch: 'any_edit' }, baselineVersion: 4, lastValue: 6 });
    pageVersion.mockRejectedValue(new Error('Confluence down'));
    expect(await reaffirmRevisit('SUP-70', 'owner-1', {}, deps)).toMatchObject({ reaffirmed: true });
    expect(repo.tripwires.get(tripwireId)?.baselineVersion).toBe(6);
  });

  it('date: marked handled (one-shot), the next evaluation stays safe', async () => {
    const { tripwireId } = await revisitingAs({ kind: 'date', spec: { date: '2026-11-01', leadDays: 30 }, lastValue: -1 });
    expect(await reaffirmRevisit('SUP-70', 'owner-1', {}, deps)).toMatchObject({ reaffirmed: true, kind: 'date' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'active', strikes: 0, spec: { date: '2026-11-01', resolved: true } });
    const evalDeps: EvalDeps = {
      repo,
      readers: { jql_threshold: vi.fn(), date: date.evaluate, checkin: vi.fn(), content_change: vi.fn() },
      openRevisit: vi.fn(),
      now: () => NOW,
    };
    expect(await evaluateOne(tripwireId, evalDeps)).toMatchObject({ outcome: 'safe', newStatus: 'active', revisitRequested: false });
  });

  it('non-numeric reaffirm still needs page edit rights and changes nothing otherwise', async () => {
    const { tripwireId } = await revisitingAs({ kind: 'checkin', spec: { every: 'month', question: 'Still true?' }, confirmedAt: daysAgo(31) });
    canEditPage.mockResolvedValue(false);
    expect(await reaffirmRevisit('SUP-70', 'owner-1', {}, deps)).toEqual({ error: 'Only people who can edit the decision page can reaffirm it.' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'revisiting', confirmedAt: daysAgo(31) });
    expect(repo.revisits.get('rv-k')?.status).toBe('open');
  });

  it('rolls a checkin back (confirmedAt included) when the revisit cannot be closed', async () => {
    const { tripwireId } = await revisitingAs({ kind: 'checkin', spec: { every: 'month', question: 'Still true?' }, confirmedAt: daysAgo(31) });
    repo.closeRevisit = vi.fn().mockResolvedValue(false);
    expect(await reaffirmRevisit('SUP-70', 'owner-1', {}, deps)).toEqual({ error: 'already resolved' });
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'revisiting', strikes: 1, confirmedAt: daysAgo(31), lastOutcome: 'tripped' });
  });

  it('parallel "Still true" clicks resolve once', async () => {
    await revisitingAs({ kind: 'checkin', spec: { every: 'month', question: 'Still true?' }, confirmedAt: daysAgo(31) });
    const results = await Promise.all([reaffirmRevisit('SUP-70', 'owner-1', {}, deps), reaffirmRevisit('SUP-70', 'owner-1', {}, deps)]);
    expect(results.filter((r) => 'reaffirmed' in r)).toHaveLength(1);
    expect(transitionToDone).toHaveBeenCalledTimes(1);
  });
});
