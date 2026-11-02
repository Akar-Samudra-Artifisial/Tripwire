import type { Repo } from '../adapters/repo';

/**
 * One background demo job at a time ("Load demo data", "Simulate a busy month" or "Reset demo"). The resolver only
 * validates and queues it; the `demo-seed` consumer does the work and records progress in the `demo-job` app value,
 * which the setup page polls.
 */
export type DemoJobKind = 'load' | 'simulate' | 'reset';
export type DemoJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface DemoJob {
  id: string;
  kind: DemoJobKind;
  status: DemoJobStatus;
  step: number;
  total: number;
  message: string;
  result?: unknown;
  error?: string;
  startedAt: string;
  updatedAt: string;
  /** Admin who clicked (the demo runs on their behalf). Never sent to the UI. */
  accountId: string;
  /** Demo pages the admin can edit, checked by the resolver: queue consumers have no user, so no `asUser()`. */
  editablePageIds: string[];
  /** Demo pages that were checked (editable or not). */
  checkedPageIds: string[];
}

/** What the setup page gets. */
export type PublicDemoJob = Omit<DemoJob, 'accountId' | 'editablePageIds' | 'checkedPageIds'>;

export const DEMO_JOB_KEY = 'demo-job';
export const DEMO_JOB_LOCK = 'demo-job';
/** A queued or running job not updated for this long is treated as failed (the consumer timeout is 900 s). */
export const DEMO_JOB_STALE_MS = 15 * 60 * 1000;
/** The start lock lasts as long as the stale limit, so a stale job never blocks a new one. */
export const DEMO_JOB_LOCK_SECONDS = DEMO_JOB_STALE_MS / 1000;
export const STALE_MESSAGE = 'The demo job stopped responding. Click the button again.';
export const STARTING_MESSAGE = 'Another demo job is starting, try again in a few seconds.';

export const DEMO_JOB_LABELS: Record<DemoJobKind, string> = {
  load: 'Load demo data',
  simulate: 'Simulate a busy month',
  reset: 'Reset demo',
};

export interface DemoJobDeps {
  repo: Pick<Repo, 'getAppValue' | 'setAppValue' | 'acquireAppLock' | 'releaseAppLock'>;
  /** Queues the job for the `demo-seed` consumer. */
  push: (jobId: string) => Promise<void>;
  now: () => number;
  newId: () => string;
}

const KINDS: readonly DemoJobKind[] = ['load', 'simulate', 'reset'];
const STATUSES: readonly DemoJobStatus[] = ['queued', 'running', 'done', 'failed'];
const PAGE_ID = /^\d{1,20}$/;

const pageIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string' && PAGE_ID.test(id)).slice(0, 50) : []);

/** The stored job, as written (no stale check); undefined when missing or malformed. */
async function readRaw(repo: DemoJobDeps['repo']): Promise<DemoJob | undefined> {
  const raw = await repo.getAppValue(DEMO_JOB_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !KINDS.includes(v.kind as DemoJobKind) || !STATUSES.includes(v.status as DemoJobStatus)) return undefined;
  if (typeof v.startedAt !== 'string' || typeof v.updatedAt !== 'string' || typeof v.accountId !== 'string') return undefined;
  return {
    id: v.id,
    kind: v.kind as DemoJobKind,
    status: v.status as DemoJobStatus,
    step: typeof v.step === 'number' ? v.step : 0,
    total: typeof v.total === 'number' ? v.total : 0,
    message: typeof v.message === 'string' ? v.message : '',
    ...(v.result !== undefined ? { result: v.result } : {}),
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
    startedAt: v.startedAt,
    updatedAt: v.updatedAt,
    accountId: v.accountId,
    editablePageIds: pageIds(v.editablePageIds),
    checkedPageIds: pageIds(v.checkedPageIds),
  };
}

export const isActive = (job: Pick<DemoJob, 'status'> | undefined): boolean => job?.status === 'queued' || job?.status === 'running';

/** The current job; a queued/running job that stopped updating is reported as failed so it can be started again. */
export async function readDemoJob(deps: Pick<DemoJobDeps, 'repo' | 'now'>): Promise<DemoJob | undefined> {
  const job = await readRaw(deps.repo);
  if (job && isActive(job) && deps.now() - Date.parse(job.updatedAt) > DEMO_JOB_STALE_MS) {
    return { ...job, status: 'failed', error: STALE_MESSAGE };
  }
  return job;
}

export function publicJob(job: DemoJob): PublicDemoJob {
  const { accountId: _account, editablePageIds: _editable, checkedPageIds: _checked, ...rest } = job;
  return rest;
}

/**
 * Starts a demo job, or returns the active one (a double click, or another button while a job runs). `access` is
 * only called when a new job is created.
 */
export async function startDemoJob(
  kind: DemoJobKind,
  accountId: string,
  access: () => Promise<{ editable: string[]; checked: string[] }>,
  deps: DemoJobDeps,
): Promise<{ job: PublicDemoJob; started: boolean } | { error: string }> {
  const current = await readDemoJob(deps);
  if (current && isActive(current)) return { job: publicJob(current), started: false };
  if (!(await deps.repo.acquireAppLock(DEMO_JOB_LOCK, new Date(deps.now()).toISOString(), DEMO_JOB_LOCK_SECONDS))) {
    const running = await readDemoJob(deps);
    return running && isActive(running) ? { job: publicJob(running), started: false } : { error: STARTING_MESSAGE };
  }
  try {
    // A job that started between the first read and the lock (its lock expired while it still runs).
    const again = await readDemoJob(deps);
    if (again && isActive(again)) return { job: publicJob(again), started: false };
    const { editable, checked } = await access();
    const at = new Date(deps.now()).toISOString();
    const job: DemoJob = {
      id: deps.newId(),
      kind,
      status: 'queued',
      step: 0,
      total: 0,
      message: 'Queued',
      startedAt: at,
      updatedAt: at,
      accountId,
      editablePageIds: pageIds(editable),
      checkedPageIds: pageIds(checked),
    };
    await deps.repo.setAppValue(DEMO_JOB_KEY, job);
    try {
      await deps.push(job.id);
    } catch (err) {
      await deps.repo.setAppValue(DEMO_JOB_KEY, { ...job, status: 'failed', error: `${DEMO_JOB_LABELS[kind]} could not be queued. Try again.`, updatedAt: new Date(deps.now()).toISOString() });
      throw err;
    }
    return { job: publicJob(job), started: true };
  } catch (err) {
    await deps.repo.releaseAppLock(DEMO_JOB_LOCK);
    throw err;
  }
}

export type DemoProgress = (step: number, total: number, message: string) => Promise<void>;

export interface RunDemoJobDeps extends Pick<DemoJobDeps, 'repo' | 'now'> {
  /** Runs the job's work; throws on failure. */
  run: (job: DemoJob, progress: DemoProgress) => Promise<unknown>;
  /** Message shown for an error the admin can act on; undefined for unexpected errors (logged, generic message). */
  userMessage: (err: unknown) => string | undefined;
}

/**
 * Consumer side: runs job `jobId` to the end and records progress and the outcome. Ignores events for a job that
 * is unknown, replaced, already finished or already running (queue redelivery). Never throws, so the queue does
 * not redeliver a job that failed halfway.
 */
export async function runDemoJob(jobId: string, deps: RunDemoJobDeps): Promise<'done' | 'failed' | 'ignored'> {
  const job = await readRaw(deps.repo);
  if (!job || job.id !== jobId || job.status !== 'queued') {
    console.info('tripwire demo job: event ignored', { jobId, current: job?.id, status: job?.status });
    return 'ignored';
  }
  let latest: DemoJob = job;
  let replaced = false;
  const write = async (patch: Partial<DemoJob>): Promise<void> => {
    const stored = await readRaw(deps.repo);
    // A newer job replaced this one (this one went stale): leave it and its lock alone.
    if (stored && stored.id !== jobId) {
      replaced = true;
      return;
    }
    latest = { ...latest, ...patch, updatedAt: new Date(deps.now()).toISOString() };
    await deps.repo.setAppValue(DEMO_JOB_KEY, latest);
  };
  try {
    await write({ status: 'running', message: 'Starting' });
    const result = await deps.run(job, (step, total, message) => write({ step, total, message }));
    await write({ status: 'done', step: latest.total, message: 'Done', result });
    return 'done';
  } catch (err) {
    const message = deps.userMessage(err);
    if (message === undefined) console.error(`Tripwire ${DEMO_JOB_LABELS[job.kind]} failed`, err);
    await write({ status: 'failed', error: message ?? `${DEMO_JOB_LABELS[job.kind]} failed. Check the app logs.` }).catch((writeErr: unknown) => {
      console.error('tripwire demo job: could not record the failure', writeErr);
    });
    return 'failed';
  } finally {
    if (!replaced) await deps.repo.releaseAppLock(DEMO_JOB_LOCK).catch((err: unknown) => {
      console.warn('tripwire demo job: lock release failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}
