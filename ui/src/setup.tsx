import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { call } from './bridge';
import { mount } from './mount';
import { Shell } from './components';

interface Settings {
  revisitProjectKey?: string;
  decisionLabel: string;
  watchedSpaceKeys: string[];
  allowedProjectKeys: string[];
}

interface Form {
  revisitProjectKey: string;
  decisionLabel: string;
  watchedSpaceKeys: string;
  allowedProjectKeys: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const toForm = (s: Settings): Form => ({
  revisitProjectKey: s.revisitProjectKey ?? '',
  decisionLabel: s.decisionLabel,
  watchedSpaceKeys: s.watchedSpaceKeys.join(', '),
  allowedProjectKeys: s.allowedProjectKeys.join(', '),
});

const toList = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);

interface InitialiseReply {
  applied: string[] | number;
  total: number;
  latest: string;
  settingUp?: boolean;
}

/** While a new install is still migrating, check again after this delay. */
const SETUP_POLL_MS = 15_000;

/** Checks the schema on open and while it is being set up; `onReady` fires when it becomes complete. */
function Initialise({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<{ busy: boolean; latest?: string; count?: number; progress?: string; error?: string }>({ busy: false });
  const [poll, setPoll] = useState(0);
  const settingUp = useRef(false);
  const run = () => {
    setState((s) => ({ busy: true, progress: s.progress }));
    call<InitialiseReply>('initialise')
      .then((r) => {
        if (r.settingUp) {
          settingUp.current = true;
          setState({ busy: false, progress: `Setting up the database… ${String(r.applied)}/${r.total} steps. Checking again in a few seconds.` });
          setTimeout(() => setPoll((n) => n + 1), SETUP_POLL_MS);
        } else {
          // Replaces the progress line, so no stale "setting up" message stays behind.
          setState({ busy: false, latest: r.latest, count: Array.isArray(r.applied) ? r.applied.length : r.applied });
          if (settingUp.current) {
            settingUp.current = false;
            onReady();
          }
        }
      })
      .catch((e: unknown) => setState({ busy: false, error: message(e) }));
  };
  useEffect(() => {
    run();
  }, [poll]);
  return (
    <section className="setup__section">
      <h2 className="setup__heading">Database</h2>
      <p className="muted">Creates or upgrades the Tripwire tables. Safe to run more than once.</p>
      <button type="button" className="setup__button" onClick={run} disabled={state.busy}>
        {state.busy ? 'Initialising…' : 'Initialise'}
      </button>
      {state.progress && !state.latest && <p role="status">{state.progress}</p>}
      {state.latest && (
        <p role="status">
          Schema up to date: latest = <code>{state.latest}</code> ({state.count} migrations applied)
        </p>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}

/** `ready` changes when the database finished setting up: the settings are loaded again (clearing a "setting up" error). */
function SettingsForm({ ready }: { ready: number }) {
  const [form, setForm] = useState<Form | undefined>();
  const [status, setStatus] = useState<{ busy: boolean; saved?: boolean; error?: string }>({ busy: false });

  useEffect(() => {
    let alive = true;
    call<Settings>('getSettings')
      .then((s) => {
        if (!alive) return;
        setForm(toForm(s));
        setStatus((st) => (st.busy ? st : { busy: false }));
      })
      .catch((e: unknown) => alive && setStatus({ busy: false, error: message(e) }));
    return () => {
      alive = false;
    };
  }, [ready]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setStatus({ busy: true });
    call<Settings>('saveSettings', {
      revisitProjectKey: form.revisitProjectKey,
      decisionLabel: form.decisionLabel,
      watchedSpaceKeys: toList(form.watchedSpaceKeys),
      allowedProjectKeys: toList(form.allowedProjectKeys),
    })
      .then((s) => {
        setForm(toForm(s));
        setStatus({ busy: false, saved: true });
      })
      .catch((e: unknown) => setStatus({ busy: false, error: message(e) }));
  };

  const field = (key: keyof Form) => ({
    value: form?.[key] ?? '',
    onChange: (e: { target: { value: string } }) => form && setForm({ ...form, [key]: e.target.value }),
    disabled: !form || status.busy,
  });

  return (
    <section className="setup__section">
      <h2 className="setup__heading">Settings</h2>
      <form onSubmit={submit} className="setup__form">
        <label>
          Jira project for Revisit tasks
          <input {...field('revisitProjectKey')} placeholder="SUP" />
        </label>
        <label>
          Decision page label
          <input {...field('decisionLabel')} placeholder="decision" />
        </label>
        <label>
          Watched Confluence spaces (comma-separated, empty = all)
          <input {...field('watchedSpaceKeys')} placeholder="ENG, PROD" />
        </label>
        <label>
          Jira projects Tripwire may count issues in (comma-separated, empty = no Jira tripwires)
          <input {...field('allowedProjectKeys')} placeholder="SUP" />
          <span className="muted">Counts run as the app, so anyone who can view a decision page sees issue counts from these projects.</span>
        </label>
        <button type="submit" className="setup__button" disabled={!form || status.busy}>
          {status.busy ? 'Saving…' : 'Save settings'}
        </button>
      </form>
      {status.saved && <p role="status">Settings saved.</p>}
      {status.error && (
        <p className="error" role="alert">
          {status.error}
        </p>
      )}
    </section>
  );
}

function LlmProbe() {
  const [state, setState] = useState<{ busy: boolean; jobId?: string; error?: string }>({ busy: false });
  const run = () => {
    setState({ busy: true });
    call<{ jobId: string }>('probeLlm')
      .then((r) => setState({ busy: false, jobId: r.jobId }))
      .catch((e: unknown) => setState({ busy: false, error: message(e) }));
  };
  return (
    <section className="setup__section">
      <h2 className="setup__heading">Forge LLM</h2>
      <p className="muted">Queues a one-line tool call to Claude to confirm Forge LLM works on this site.</p>
      <button type="button" className="setup__button" onClick={run} disabled={state.busy}>
        {state.busy ? 'Queueing…' : 'Test LLM'}
      </button>
      {state.jobId && (
        <p role="status">
          Queued job <code>{state.jobId}</code>. Check <code>forge logs</code> for "llm probe".
        </p>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}

interface RunResult {
  evaluated: number;
  skipped: number;
  errors: number;
  revisits: number;
  total: number;
  truncated: boolean;
  rateLimited: boolean;
}

function RunEvaluation() {
  const [state, setState] = useState<{ busy: boolean; result?: RunResult; error?: string }>({ busy: false });
  const run = () => {
    setState({ busy: true });
    call<RunResult>('runEvaluationNow')
      .then((result) => setState({ busy: false, result }))
      .catch((e: unknown) => setState({ busy: false, error: message(e) }));
  };
  const r = state.result;
  return (
    <section className="setup__section">
      <h2 className="setup__heading">Evaluation</h2>
      <p className="muted">Tripwires are evaluated daily. Run now to measure every confirmed tripwire immediately (up to 100).</p>
      <button type="button" className="setup__button" onClick={run} disabled={state.busy}>
        {state.busy ? 'Evaluating…' : 'Run evaluation now'}
      </button>
      {r && (
        <p role="status">
          {r.evaluated} evaluated · {r.skipped} skipped · {r.errors} errors · {r.revisits} Revisit requests (of {r.total})
          {r.truncated && ' · more than 100 tripwires: the rest run in the daily evaluation'}
          {r.rateLimited && ' · Jira rate limit reached: try again in a minute'}
        </p>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}

interface LoadDemoPage {
  slug: string;
  title: string;
  team: string;
  pageId: string;
  pageUrl?: string;
  created: boolean;
  extractionQueued: boolean;
}

interface LoadDemoResult {
  projectKey: string;
  revisitProjectKey: string;
  issueCount: number;
  billingIssueCount: number;
  spaceKey: string;
  pageId: string;
  pageUrl?: string;
  pages: LoadDemoPage[];
  complete: boolean;
  canEdit: boolean | null;
  extractionJobId?: string;
  extractionsQueued: number;
  created: { project: boolean; issues: number; billingIssues: number; space: boolean; page: boolean; label: boolean; pages: number };
}

interface SimulateResult {
  created: number;
  issueCount: number;
  billingIssueCount: number;
  confirmed: number;
  queued: number;
  indexed: boolean;
  complete: boolean;
  passes: { evaluated: number; skipped: number; errors: number; revisits: number; total: number; rateLimited: boolean }[];
  revisits: { tripwireId: string; issueKey: string }[];
}

interface ResetDemoResult {
  relabelled: number;
  remaining: number;
  revisitIssueKeys: string[];
  deleted: { tripwires: number; assumptions: number; evaluations: number; revisits: number } | null;
  decisionsReset: number;
  extractionJobId?: string;
  extractionsQueued: number;
  indexed: boolean;
  complete: boolean;
  message?: string;
  warnings: string[];
}

type DemoJobKind = 'load' | 'simulate' | 'reset';

/** A demo job as returned by `loadDemoData` / `simulateBusyMonth` / `resetDemo` / `getDemoJob`. */
interface DemoJob {
  id: string;
  kind: DemoJobKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  step: number;
  total: number;
  message: string;
  result?: unknown;
  error?: string;
}

/** How often the page checks a running demo job. */
const DEMO_POLL_MS = 4000;

/** Reply of `stampDemoReviews`. */
interface StampResult {
  stamped: number;
  skipped: number;
  failed: number;
  pending: number;
  graphCachesCleared: number;
}

/** Pages still being extracted after Load are stamped on a later try (15 s apart, about 3 minutes in all). */
const STAMP_RETRY_MS = 15_000;
const STAMP_TRIES = 12;

const RESOLVERS: Record<DemoJobKind, string> = { load: 'loadDemoData', simulate: 'simulateBusyMonth', reset: 'resetDemo' };
const RUNNING: Record<DemoJobKind, string> = { load: 'Loading demo data', simulate: 'Simulating a busy month', reset: 'Resetting the demo' };

const isActive = (job: DemoJob | undefined) => job?.status === 'queued' || job?.status === 'running';

/** Progress line of a running job, e.g. "Loading demo data… step 3/10: Decision page 1 of 8". */
function JobProgress({ job }: { job: DemoJob | undefined }) {
  if (!job || !isActive(job)) return null;
  return (
    <p role="status">
      {RUNNING[job.kind]}… {job.step > 0 ? `step ${job.step}/${job.total}: ${job.message}` : 'queued, starting in a few seconds'}
    </p>
  );
}

/** Error of a failed job, or of a click that could not start one. */
function JobError({ job, error }: { job: DemoJob | undefined; error: string | undefined }) {
  const text = error ?? (job?.status === 'failed' ? (job.error ?? 'The demo job failed. Check the app logs.') : undefined);
  if (!text) return null;
  return (
    <p className="error" role="alert">
      {text}
    </p>
  );
}

/** Result of a job that finished. */
const doneResult = <T,>(job: DemoJob | undefined): T | undefined => (job?.status === 'done' ? (job.result as T | undefined) : undefined);

function ResetDemo({ job, error, disabled, onRun }: { job: DemoJob | undefined; error?: string; disabled: boolean; onRun: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const run = () => {
    // Two clicks instead of window.confirm: modals are not available in the Custom UI iframe.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onRun();
  };
  const r = doneResult<ResetDemoResult>(job);
  return (
    <>
      <p className="muted">
        Resets the demo so it can be replayed: the busy month tickets lose the <code>export</code>/<code>billing</code> label
        (nothing is deleted), the demo Revisit tasks move to Done, all eight demo decisions and their Radar pairs are cleared,
        the Lumora pages get today's dates again and every page is extracted again (tripwires are proposed again). Nothing
        outside the demo is touched.
      </p>
      <div className="assumption__actions">
        <button type="button" className="setup__button" onClick={run} disabled={disabled}>
          {isActive(job) ? 'Resetting…' : confirming ? 'Click again to reset the demo' : 'Reset demo'}
        </button>
        {confirming && (
          <button type="button" className="setup__button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        )}
      </div>
      <JobProgress job={job} />
      {r && (
        <p role="status">
          {r.complete ? 'Demo reset' : `Not finished: ${r.message ?? 'click Reset demo again'}`} · {r.relabelled} busy month tickets
          relabelled · {r.remaining} export tickets left · {r.decisionsReset} decisions reset
          {r.revisitIssueKeys.length > 0 && ` · ${r.revisitIssueKeys.join(', ')} closed`}
          {r.deleted &&
            ` · removed ${r.deleted.tripwires} tripwires, ${r.deleted.evaluations} evaluations, ${r.deleted.revisits} revisits`}
          {r.extractionsQueued > 0 &&
            ` · ${r.extractionsQueued} extractions queued: open "Defer CSV export" and accept its tripwire again`}
        </p>
      )}
      {r?.warnings.map((w) => (
        <p key={w} className="error" role="alert">
          {w}
        </p>
      ))}
      <JobError job={job} error={error} />
    </>
  );
}

/**
 * The demo buttons queue a background job and return at once; the page shows its progress and polls until it is
 * done. A job still running when the page is opened again is picked up the same way.
 */
function DemoData({ ready }: { ready: number }) {
  const [jobs, setJobs] = useState<Partial<Record<DemoJobKind, DemoJob>>>({});
  const [errors, setErrors] = useState<Partial<Record<DemoJobKind, string>>>({});
  const [starting, setStarting] = useState<DemoJobKind | undefined>();
  const [retry, setRetry] = useState(0);
  const remember = (job: DemoJob | null | undefined) => {
    if (job) setJobs((prev) => ({ ...prev, [job.kind]: job }));
  };

  // On open (and once the database is ready): a job may still be running from an earlier visit.
  useEffect(() => {
    let alive = true;
    call<{ job: DemoJob | null }>('getDemoJob')
      .then((r) => alive && remember(r.job))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ready]);

  const active = Object.values(jobs).find((j) => isActive(j));
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      call<{ job: DemoJob | null }>('getDemoJob')
        .then((r) => remember(r.job ?? { ...active, status: 'failed', error: 'The demo job disappeared. Click the button again.' }))
        // A failed poll (network, timeout): try again on the next tick.
        .catch(() => setRetry((n) => n + 1));
    }, DEMO_POLL_MS);
    return () => clearTimeout(timer);
  }, [active, retry]);

  // A Load seen running on this page gets the "Reviewed by" notes once it is done.
  const loadSeenRunning = useRef<string | undefined>(undefined);
  const [stamp, setStamp] = useState<{ busy: boolean; tries: number; result?: StampResult; error?: string }>({ busy: false, tries: 0 });
  const runStamp = (tries: number) => {
    setStamp((prev) => ({ ...prev, busy: true, tries, error: undefined }));
    call<StampResult>('stampDemoReviews')
      .then((r) =>
        setStamp((prev) => {
          // Pages stamped on an earlier try come back as skipped (already noted): count them as stamped.
          const earlier = tries > 1 ? (prev.result?.stamped ?? 0) : 0;
          return { busy: false, tries, result: { ...r, stamped: r.stamped + earlier, skipped: Math.max(0, r.skipped - earlier) } };
        }),
      )
      .catch((e: unknown) => setStamp({ busy: false, tries, error: message(e) }));
  };
  useEffect(() => {
    const job = jobs.load;
    if (job && isActive(job)) loadSeenRunning.current = job.id;
    else if (job?.status === 'done' && loadSeenRunning.current === job.id) {
      loadSeenRunning.current = undefined;
      runStamp(1);
    }
  }, [jobs.load]);
  // Pages still being extracted are stamped on a later try.
  useEffect(() => {
    if (stamp.busy || !stamp.result || stamp.result.pending === 0 || stamp.tries >= STAMP_TRIES) return;
    const timer = setTimeout(() => runStamp(stamp.tries + 1), STAMP_RETRY_MS);
    return () => clearTimeout(timer);
  }, [stamp]);

  const start = (kind: DemoJobKind) => {
    setStarting(kind);
    setErrors((prev) => ({ ...prev, [kind]: undefined }));
    call<{ job: DemoJob; started: boolean }>(RESOLVERS[kind])
      .then((r) => remember(r.job))
      .catch((e: unknown) => setErrors((prev) => ({ ...prev, [kind]: message(e) })))
      .finally(() => setStarting(undefined));
  };

  const busy = starting !== undefined || active !== undefined;
  const l = doneResult<LoadDemoResult>(jobs.load);
  const s = doneResult<SimulateResult>(jobs.simulate);
  return (
    <section className="setup__section">
      <h2 className="setup__heading">Demo data</h2>
      <p className="muted">
        Creates the Lumora demo: Jira project SUP with 7 tickets labelled <code>export</code> and 2 labelled <code>billing</code>,
        Confluence space Decisions with eight decision pages from seven teams (label <code>decision</code>), starting with "Defer
        CSV export", and points the settings at SUP. Three pairs of pages contradict each other for the Radar. Safe to run more
        than once.
      </p>
      <button type="button" className="setup__button" onClick={() => start('load')} disabled={busy}>
        {starting === 'load' || isActive(jobs.load) ? 'Loading…' : 'Load demo data'}
      </button>
      <JobProgress job={jobs.load} />
      {l && (
        <>
          <p role="status">
            {l.projectKey}: {l.issueCount} export and {l.billingIssueCount} billing tickets (
            {l.created.issues + l.created.billingIssues} new{l.created.project && ', project created'}) · {l.pages.length} decision
            pages in {l.spaceKey} ({l.created.pages} created) · {l.extractionsQueued} extractions queued
            {l.extractionJobId && ': open "Defer CSV export" and accept its tripwire'}
            {l.revisitProjectKey !== l.projectKey && ` · Revisit tasks go to ${l.revisitProjectKey} (your setting)`}
            {!l.complete && ' · not finished: click Load demo data again in a minute'}
          </p>
          <ul>
            {l.pages.map((p) => (
              <li key={p.slug}>
                {p.pageUrl ? (
                  <a href={p.pageUrl} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}{' '}
                · {p.team}
                {p.created && ' (created)'}
              </li>
            ))}
          </ul>
        </>
      )}
      {l && l.canEdit === false && (
        <p className="error" role="alert">
          You cannot edit the demo page, so you cannot accept its tripwire. Give yourself access in the {l.spaceKey} space
          permissions (Tripwire created the space as the app).
        </p>
      )}
      {(stamp.busy || stamp.result) && (
        <p role="status" className="muted">
          {stamp.busy && !stamp.result
            ? 'Adding "Reviewed by" notes to the demo pages as you…'
            : stamp.result &&
              `"Reviewed by" added to ${stamp.result.stamped} page${stamp.result.stamped === 1 ? '' : 's'} as you (Teamwork Graph contributor for the Radar)` +
                (stamp.result.skipped > 0 ? ` · ${stamp.result.skipped} skipped (already noted or not editable)` : '') +
                (stamp.result.pending > 0 ? ` · ${stamp.result.pending} still being extracted${stamp.tries < STAMP_TRIES ? ', retrying' : ''}` : '') +
                (stamp.result.failed > 0 ? ` · ${stamp.result.failed} failed (see app logs)` : '')}
        </p>
      )}
      {stamp.error && (
        <p className="error" role="alert">
          "Reviewed by" notes not added: {stamp.error}
        </p>
      )}
      <JobError job={jobs.load} error={errors.load} />
      <p className="muted">
        Adds 30 more <code>export</code> and 6 <code>billing</code> tickets to SUP (once), confirms the proposed tripwires of the
        other seven demo pages you can edit, moves dates and check-ins a month on, then evaluates the Jira-count tripwires twice
        so a crossed threshold trips and opens a Revisit task. The other tripwires are evaluated in the background.
      </p>
      <button type="button" className="setup__button" onClick={() => start('simulate')} disabled={busy}>
        {starting === 'simulate' || isActive(jobs.simulate) ? 'Simulating…' : 'Simulate a busy month'}
      </button>
      <JobProgress job={jobs.simulate} />
      {s && (
        <p role="status">
          {s.created} tickets created · now {s.issueCount} export and {s.billingIssueCount} billing tickets in SUP
          {s.confirmed > 0 && ` · ${s.confirmed} demo tripwires confirmed`}
          {!s.indexed && ' · Jira search is still catching up, nothing evaluated yet'}
          {s.passes.map((p, i) => ` · pass ${i + 1}: ${p.evaluated} evaluated, ${p.errors} errors${p.rateLimited ? ', rate limited' : ''}`)}
          {s.revisits.length > 0 ? ` · Revisit: ${s.revisits.map((r) => r.issueKey).join(', ')}` : ' · no Revisit opened'}
          {s.queued > 0 && ` · ${s.queued} date/check-in/page tripwires queued (their Revisit tasks follow within a minute)`}
          {!s.complete && ' · not finished: click again to evaluate (no new tickets are created)'}
        </p>
      )}
      <JobError job={jobs.simulate} error={errors.simulate} />
      <ResetDemo job={jobs.reset} error={errors.reset} disabled={busy} onRun={() => start('reset')} />
    </section>
  );
}

function Setup() {
  // Bumped when the database finishes setting up, so sections that failed with "setting up" load again.
  const [ready, setReady] = useState(0);
  const onReady = useCallback(() => setReady((n) => n + 1), []);
  return (
    <Shell title="Tripwire setup">
      <Initialise onReady={onReady} />
      <SettingsForm ready={ready} />
      <DemoData ready={ready} />
      <RunEvaluation />
      <LlmProbe />
    </Shell>
  );
}

mount(<Setup />);
