import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRepo, type FakeRepo } from './helpers/fakeRepo';
import {
  DEMO_JOB_KEY,
  DEMO_JOB_LOCK,
  DEMO_JOB_LOCK_SECONDS,
  DEMO_JOB_STALE_MS,
  readDemoJob,
  runDemoJob,
  STALE_MESSAGE,
  STARTING_MESSAGE,
  startDemoJob,
  type DemoJobDeps,
} from '../src/surfaces/demoJob';

const NOW = Date.parse('2026-11-02T10:00:00Z');
let repo: FakeRepo;
let clock: number;
let ids: number;

const deps = (): DemoJobDeps & { push: ReturnType<typeof vi.fn> } => ({
  repo,
  push: vi.fn(async () => undefined),
  now: () => clock,
  newId: () => `job-${++ids}`,
});
const noAccess = async () => ({ editable: [], checked: [] });

beforeEach(() => {
  repo = fakeRepo();
  clock = NOW;
  ids = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('startDemoJob', () => {
  it('stores a queued job, pushes it and returns at once', async () => {
    const d = deps();
    const r = await startDemoJob('load', 'acc-1', async () => ({ editable: ['1'], checked: ['1', '2'] }), d);
    expect(r).toEqual({ started: true, job: expect.objectContaining({ id: 'job-1', kind: 'load', status: 'queued' }) });
    expect(d.push).toHaveBeenCalledWith('job-1');
    expect(repo.appValues.get(DEMO_JOB_KEY)).toMatchObject({ accountId: 'acc-1', editablePageIds: ['1'], checkedPageIds: ['1', '2'] });
  });

  it('a second click while the job is queued or running returns the same job', async () => {
    const d = deps();
    await startDemoJob('simulate', 'acc-1', noAccess, d);
    const access = vi.fn(noAccess);
    const again = await startDemoJob('simulate', 'acc-1', access, d);
    expect(again).toEqual({ started: false, job: expect.objectContaining({ id: 'job-1' }) });
    expect(d.push).toHaveBeenCalledTimes(1);
    expect(access).not.toHaveBeenCalled();
  });

  it('two clicks racing for the lock: the loser gets a short "starting" message', async () => {
    repo.appLocks.set(DEMO_JOB_LOCK, new Date(NOW + 60_000).toISOString());
    expect(await startDemoJob('load', 'acc-1', noAccess, deps())).toEqual({ error: STARTING_MESSAGE });
  });

  it('a stuck job (no update for 15 minutes) counts as failed and a new one can start', async () => {
    const d = deps();
    await startDemoJob('load', 'acc-1', noAccess, d);
    clock += DEMO_JOB_STALE_MS + 1000;
    expect(await readDemoJob(d)).toMatchObject({ id: 'job-1', status: 'failed', error: STALE_MESSAGE });
    const next = await startDemoJob('load', 'acc-1', noAccess, d);
    expect(next).toMatchObject({ started: true, job: { id: 'job-2', status: 'queued' } });
    expect(DEMO_JOB_LOCK_SECONDS * 1000).toBeLessThanOrEqual(DEMO_JOB_STALE_MS);
  });

  it('a push failure marks the job failed and frees the lock', async () => {
    const d = deps();
    d.push.mockRejectedValue(new Error('queue down'));
    await expect(startDemoJob('load', 'acc-1', noAccess, d)).rejects.toThrow('queue down');
    expect(repo.appValues.get(DEMO_JOB_KEY)).toMatchObject({ status: 'failed' });
    expect(repo.appLocks.has(DEMO_JOB_LOCK)).toBe(false);
  });
});

describe('runDemoJob', () => {
  it('runs to done, records each progress step and the result, then frees the lock', async () => {
    const d = deps();
    await startDemoJob('load', 'acc-1', noAccess, d);
    const seen: unknown[] = [];
    const outcome = await runDemoJob('job-1', {
      repo,
      now: () => clock,
      userMessage: () => undefined,
      run: async (job, progress) => {
        expect(job.accountId).toBe('acc-1');
        await progress(1, 2, 'first');
        seen.push(await readDemoJob(d));
        await progress(2, 2, 'second');
        return { ok: true };
      },
    });
    expect(outcome).toBe('done');
    expect(seen[0]).toMatchObject({ status: 'running', step: 1, total: 2, message: 'first' });
    expect(await readDemoJob(d)).toMatchObject({ status: 'done', step: 2, total: 2, result: { ok: true } });
    expect(repo.appLocks.has(DEMO_JOB_LOCK)).toBe(false);
  });

  it('ignores redelivered events (job already running or finished, or replaced)', async () => {
    const d = deps();
    await startDemoJob('load', 'acc-1', noAccess, d);
    const run = vi.fn(async () => 'x');
    const base = { repo, now: () => clock, userMessage: () => undefined, run };
    expect(await runDemoJob('job-1', base)).toBe('done');
    expect(await runDemoJob('job-1', base)).toBe('ignored');
    expect(await runDemoJob('job-0', base)).toBe('ignored');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('failures become a failed job: admin-fixable message as is, anything else generic', async () => {
    const d = deps();
    await startDemoJob('simulate', 'acc-1', noAccess, d);
    await runDemoJob('job-1', { repo, now: () => clock, userMessage: (e) => (e as Error).message, run: async () => { throw new Error('Run "Load demo data" first.'); } });
    expect(await readDemoJob(d)).toMatchObject({ status: 'failed', error: 'Run "Load demo data" first.' });
    await startDemoJob('reset', 'acc-1', noAccess, d);
    await runDemoJob('job-2', { repo, now: () => clock, userMessage: () => undefined, run: async () => { throw new Error('boom'); } });
    expect(await readDemoJob(d)).toMatchObject({ status: 'failed', error: 'Reset demo failed. Check the app logs.' });
    expect(repo.appLocks.has(DEMO_JOB_LOCK)).toBe(false);
  });
});
