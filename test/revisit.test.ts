import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestJira = vi.fn<(path: unknown, init?: { body?: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>>();
vi.mock('@forge/api', () => ({
  default: { asApp: () => ({ requestJira }) },
  route: (strings: TemplateStringsArray, ...values: unknown[]) => strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''),
}));

const { jira, JiraError } = await import('../src/adapters/jira');
const { evaluateOne } = await import('../src/core/evaluator');
const { openRevisit, revisitDescription, revisitSummary } = await import('../src/core/revisit');
const { thresholdOutcome } = await import('../src/core/triggers/common');
const { fakeRepo } = await import('./helpers/fakeRepo');
const { seedTripwire } = await import('./helpers/seed');

import type { EvalDeps } from '../src/core/evaluator';
import type { RevisitDeps } from '../src/core/revisit';
import type { FakeRepo } from './helpers/fakeRepo';

let repo: FakeRepo;
let issueNo: number;
const createIssue = vi.fn<RevisitDeps['jira']['createIssue']>();
const getProject = vi.fn<RevisitDeps['jira']['getProject']>();
let deps: RevisitDeps;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  repo = fakeRepo();
  repo.settings = { ...repo.settings, revisitProjectKey: 'SUP', allowedProjectKeys: ['SUP'] };
  issueNo = 0;
  createIssue.mockReset().mockImplementation(async () => {
    issueNo += 1;
    return { id: `100${issueNo}`, key: `SUP-${issueNo}`, url: `https://one-atlas-vyyd.atlassian.net/browse/SUP-${issueNo}` };
  });
  getProject.mockReset().mockResolvedValue({ id: '1', key: 'SUP', name: 'Support' });
  deps = { repo, jira: { createIssue, getProject }, now: () => new Date('2026-11-02T09:00:00Z') };
});

function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  return (n.text ?? '') + (n.content ?? []).map(adfText).join('\n');
}

function adfTypes(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return out;
  const n = node as { type?: string; content?: unknown[] };
  if (n.type) out.add(n.type);
  for (const c of n.content ?? []) adfTypes(c, out);
  return out;
}

describe('revisitSummary', () => {
  it('cuts the statement to 80 characters', () => {
    const long = 'x'.repeat(200);
    const summary = revisitSummary({ id: 'd', pageId: '1', statement: long, topics: [], status: 'active' });
    expect(summary.startsWith('Revisit decision: ')).toBe(true);
    expect(summary.length).toBe('Revisit decision: '.length + 80);
    expect(summary.endsWith('…')).toBe(true);
    expect(revisitSummary({ id: 'd', pageId: '1', statement: 'Defer CSV export', topics: [], status: 'active' })).toBe(
      'Revisit decision: Defer CSV export',
    );
  });
});

describe('revisitDescription', () => {
  it('contains quote, threshold and date, and keeps markup from input as plain text', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2, quote: 'fewer than 10 <script>alert(1)</script> ask' });
    await repo.casTripwire(tripwireId, ['tripped'], { lastValue: 37, lastEvaluatedAt: '2026-11-02T09:00:00.000Z' });
    const ctx = (await repo.getTripwireContext(tripwireId))!;
    const evaluations = [
      { id: 'e2', tripwireId, value: 37, outcome: 'tripped' as const, evaluatedAt: '2026-11-02T09:00:00.000Z' },
      { id: 'e1', tripwireId, value: 36, outcome: 'tripped' as const, evaluatedAt: '2026-11-01T09:00:00.000Z' },
    ];
    const doc = revisitDescription(ctx, evaluations, 'https://example.atlassian.net/wiki/x');
    const text = adfText(doc);
    expect(text).toContain('fewer than 10 <script>alert(1)</script> ask');
    expect(text).toContain('trips when > 10');
    expect(text).toContain('37 (measured 2026-11-02) · threshold > 10');
    expect(text).toContain('Condition held on 2 consecutive evaluations.');
    expect(text).toContain('2026-11-01 · 36 · tripped');
    expect([...adfTypes(doc)].sort()).toEqual(['blockquote', 'bulletList', 'doc', 'heading', 'listItem', 'paragraph', 'text']);
  });
});

describe('openRevisit', () => {
  it('happy path: one issue, status revisiting, open revisit row, invalidated-by relation', async () => {
    const { tripwireId, decisionId, assumptionId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    await repo.insertEvaluation({ id: 'ev-1', tripwireId, value: 37, outcome: 'tripped', evaluatedAt: '2026-11-02T09:00:00.000Z' });
    const result = await openRevisit(tripwireId, { ...deps, pageUrl: async () => 'https://site/wiki/page' });
    expect(result).toEqual({ created: true, issueKey: 'SUP-1', url: 'https://one-atlas-vyyd.atlassian.net/browse/SUP-1' });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0]![0]).toMatchObject({
      projectKey: 'SUP',
      summary: 'Revisit decision: We decided to defer CSV export to next year.',
      labels: ['tripwire', 'decision-revisit'],
      assigneeAccountId: 'owner-1',
    });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('revisiting');
    expect([...repo.revisits.values()]).toMatchObject([{ decisionId, tripwireId, issueKey: 'SUP-1', status: 'open' }]);
    expect(repo.relations).toMatchObject([{ type: 'invalidated-by', fromId: assumptionId, toId: 'ev-1' }]);
  });

  it('two parallel calls create the issue once', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    const results = await Promise.all([openRevisit(tripwireId, deps), openRevisit(tripwireId, deps)]);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.find((r) => !r.created)).toMatchObject({ created: false, reason: expect.stringMatching(/^(concurrent|already_open)$/) });
    expect(repo.revisits.size).toBe(1);
  });

  it('a decision with an open revisit from another tripwire returns already_open without creating', async () => {
    const first = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    await openRevisit(first.tripwireId, deps);
    const second = seedTripwire(repo, { status: 'tripped', strikes: 2, decisionId: first.decisionId });
    const result = await openRevisit(second.tripwireId, deps);
    expect(result).toEqual({ created: false, reason: 'already_open', issueKey: 'SUP-1' });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(repo.tripwires.get(second.tripwireId)?.status).toBe('revisiting');
    expect(repo.relations.at(-1)).toMatchObject({ type: 'invalidated-by', fromId: second.assumptionId, toId: 'SUP-1' });
  });

  it('no Revisit project → no_project and the tripwire goes back to tripped', async () => {
    repo.settings = { ...repo.settings, revisitProjectKey: undefined };
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    expect(await openRevisit(tripwireId, deps)).toEqual({ created: false, reason: 'no_project' });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('tripped');
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('missing Jira project → jira_unavailable and back to tripped', async () => {
    getProject.mockResolvedValueOnce(undefined);
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    expect(await openRevisit(tripwireId, deps)).toMatchObject({ created: false, reason: 'jira_unavailable' });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('tripped');
  });

  it('createIssue throwing → jira_error and back to tripped', async () => {
    createIssue.mockRejectedValueOnce(new JiraError(400, 'Jira 400: summary: too long'));
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    expect(await openRevisit(tripwireId, deps)).toEqual({ created: false, reason: 'jira_error', message: 'Jira 400: summary: too long' });
    expect(repo.tripwires.get(tripwireId)?.status).toBe('tripped');
    expect(repo.revisits.size).toBe(0);
  });

  it('a failing rollback is logged, not thrown (R2)', async () => {
    getProject.mockResolvedValueOnce(undefined);
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    const cas = repo.casTripwire.bind(repo);
    vi.spyOn(repo, 'casTripwire').mockImplementation(async (id, from, patch, expect) => {
      if (from.includes('revisiting')) throw new Error('sql down');
      return cas(id, from, patch, expect);
    });
    expect(await openRevisit(tripwireId, deps)).toMatchObject({ created: false, reason: 'jira_unavailable' });
    expect(console.error).toHaveBeenCalledWith('tripwire revisit: rollback to tripped failed', expect.objectContaining({ tripwireId }));
  });

  it('retries insertRevisit once after a failure (R3)', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    const insert = repo.insertRevisit.bind(repo);
    const spy = vi.spyOn(repo, 'insertRevisit').mockRejectedValueOnce(new Error('timeout')).mockImplementation(insert);
    expect(await openRevisit(tripwireId, deps)).toMatchObject({ created: true, issueKey: 'SUP-1' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(repo.revisits.size).toBe(1);
  });

  it('logs an orphan issue when insertRevisit fails twice, and never rolls back (R3)', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    vi.spyOn(repo, 'insertRevisit').mockRejectedValue(new Error('sql down'));
    expect(await openRevisit(tripwireId, deps)).toMatchObject({ created: true, issueKey: 'SUP-1' });
    expect(console.error).toHaveBeenCalledWith('tripwire revisit orphan issue=SUP-1', expect.objectContaining({ tripwireId }));
    expect(repo.tripwires.get(tripwireId)?.status).toBe('revisiting');
  });

  it('two tripwires of one decision in parallel create one issue (R4)', async () => {
    const first = seedTripwire(repo, { status: 'tripped', strikes: 2 });
    const second = seedTripwire(repo, { status: 'tripped', strikes: 2, decisionId: first.decisionId });
    const results = await Promise.all([openRevisit(first.tripwireId, deps), openRevisit(second.tripwireId, deps)]);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.find((r) => !r.created)).toMatchObject({ created: false, reason: 'decision_locked' });
    const loser = results[0]?.created ? second.tripwireId : first.tripwireId;
    expect(repo.tripwires.get(loser)?.status).toBe('tripped');
    // The decision lock is released, so the loser's next attempt links to the open revisit.
    expect(await openRevisit(loser, deps)).toMatchObject({ created: false, reason: 'already_open', issueKey: 'SUP-1' });
  });

  it('a tripwire that is not tripped returns not_tripped', async () => {
    const { tripwireId } = seedTripwire(repo, { status: 'near', strikes: 1 });
    expect(await openRevisit(tripwireId, deps)).toEqual({ created: false, reason: 'not_tripped' });
    expect(await openRevisit('missing', deps)).toEqual({ created: false, reason: 'not_found' });
    expect(createIssue).not.toHaveBeenCalled();
  });
});

describe('jira.createIssue', () => {
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

  beforeEach(() => requestJira.mockReset());

  it('retries without the assignee when Jira rejects it with 400', async () => {
    requestJira
      .mockResolvedValueOnce(reply(200, { issueTypes: [{ id: '5', name: 'Bug' }, { id: '7', name: 'Task' }] }))
      .mockResolvedValueOnce(reply(400, { errors: { assignee: 'User cannot be assigned issues.' } }))
      .mockResolvedValueOnce(reply(201, { id: '10001', key: 'SUP-9', self: 'https://one-atlas-vyyd.atlassian.net/rest/api/3/issue/10001' }));
    const issue = await jira.createIssue({
      projectKey: 'SUP',
      summary: 'Revisit decision: x',
      description: { type: 'doc', version: 1, content: [] },
      labels: ['tripwire'],
      assigneeAccountId: 'owner-1',
    });
    expect(issue).toEqual({ id: '10001', key: 'SUP-9', url: 'https://one-atlas-vyyd.atlassian.net/browse/SUP-9' });
    const first = JSON.parse(requestJira.mock.calls[1]![1]!.body!) as { fields: Record<string, unknown> };
    const second = JSON.parse(requestJira.mock.calls[2]![1]!.body!) as { fields: Record<string, unknown> };
    expect(first.fields).toMatchObject({ assignee: { accountId: 'owner-1' }, issuetype: { id: '7' } });
    expect(second.fields.assignee).toBeUndefined();
  });

  it('does not retry other 400 errors', async () => {
    requestJira
      .mockResolvedValueOnce(reply(200, { issueTypes: [{ id: '7', name: 'Task' }] }))
      .mockResolvedValueOnce(reply(400, { errors: { summary: 'too long' } }));
    await expect(
      jira.createIssue({ projectKey: 'SUP', summary: 's', description: { type: 'doc', version: 1, content: [] }, labels: [], assigneeAccountId: 'o' }),
    ).rejects.toBeInstanceOf(JiraError);
    expect(requestJira).toHaveBeenCalledTimes(2);
  });
});

describe('evaluator + openRevisit', () => {
  it('7 → 37 → 37 opens exactly one issue; a 4th evaluation does not open a second', async () => {
    const { tripwireId } = seedTripwire(repo);
    let count = 7;
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const evalDeps: EvalDeps = {
      repo,
      readers: {
        jql_threshold: async (spec) => ({ value: count, outcome: thresholdOutcome(count, spec.op, spec.value) }),
        date: vi.fn(),
        checkin: vi.fn(),
        content_change: vi.fn(),
      },
      openRevisit: (id) => openRevisit(id, deps),
      now: () => new Date((clock += 86_400_000)),
    };

    await evaluateOne(tripwireId, evalDeps);
    expect(repo.tripwires.get(tripwireId)?.status).toBe('active');
    count = 37;
    await evaluateOne(tripwireId, evalDeps);
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'near', strikes: 1 });
    expect(createIssue).not.toHaveBeenCalled();
    await evaluateOne(tripwireId, evalDeps);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(repo.tripwires.get(tripwireId)).toMatchObject({ status: 'revisiting', strikes: 2, lastValue: 37 });

    await evaluateOne(tripwireId, evalDeps);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(repo.revisits.size).toBe(1);
    expect(repo.evaluations).toHaveLength(4);
    expect(repo.tripwires.get(tripwireId)?.status).toBe('revisiting');
  });
});
