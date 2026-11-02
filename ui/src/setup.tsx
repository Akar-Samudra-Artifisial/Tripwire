import { useEffect, useState, type FormEvent } from 'react';
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

function Initialise() {
  const [state, setState] = useState<{ busy: boolean; latest?: string; count?: number; error?: string }>({ busy: false });
  const run = () => {
    setState({ busy: true });
    call<{ applied: string[]; latest: string }>('initialise')
      .then((r) => setState({ busy: false, latest: r.latest, count: r.applied.length }))
      .catch((e: unknown) => setState({ busy: false, error: message(e) }));
  };
  return (
    <section className="setup__section">
      <h2 className="setup__heading">Database</h2>
      <p className="muted">Creates or upgrades the Tripwire tables. Safe to run more than once.</p>
      <button type="button" className="setup__button" onClick={run} disabled={state.busy}>
        {state.busy ? 'Initialising…' : 'Initialise'}
      </button>
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

function SettingsForm() {
  const [form, setForm] = useState<Form | undefined>();
  const [status, setStatus] = useState<{ busy: boolean; saved?: boolean; error?: string }>({ busy: false });

  useEffect(() => {
    let alive = true;
    call<Settings>('getSettings')
      .then((s) => alive && setForm(toForm(s)))
      .catch((e: unknown) => alive && setStatus({ busy: false, error: message(e) }));
    return () => {
      alive = false;
    };
  }, []);

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

function ResetDemo({ disabled, onBusy }: { disabled: boolean; onBusy: (busy: boolean) => void }) {
  const [state, setState] = useState<{ busy: boolean; confirming: boolean; result?: ResetDemoResult; error?: string }>({
    busy: false,
    confirming: false,
  });
  const run = () => {
    // Two clicks instead of window.confirm: modals are not available in the Custom UI iframe.
    if (!state.confirming) {
      setState({ busy: false, confirming: true });
      return;
    }
    setState({ busy: true, confirming: false });
    onBusy(true);
    call<ResetDemoResult>('resetDemo')
      .then((result) => setState({ busy: false, confirming: false, result }))
      .catch((e: unknown) => setState({ busy: false, confirming: false, error: message(e) }))
      .finally(() => onBusy(false));
  };
  const r = state.result;
  return (
    <>
      <p className="muted">
        Resets the demo so it can be replayed: the busy month tickets lose the <code>export</code>/<code>billing</code> label
        (nothing is deleted), the demo Revisit tasks move to Done, all eight demo decisions and their Radar pairs are cleared,
        the Lumora pages get today's dates again and every page is extracted again (tripwires are proposed again). Nothing
        outside the demo is touched.
      </p>
      <div className="assumption__actions">
        <button type="button" className="setup__button" onClick={run} disabled={disabled || state.busy}>
          {state.busy ? 'Resetting…' : state.confirming ? 'Click again to reset the demo' : 'Reset demo'}
        </button>
        {state.confirming && (
          <button type="button" className="setup__button" onClick={() => setState({ busy: false, confirming: false })}>
            Cancel
          </button>
        )}
      </div>
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
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </>
  );
}

function DemoData() {
  const [load, setLoad] = useState<{ busy: boolean; result?: LoadDemoResult; error?: string }>({ busy: false });
  const [sim, setSim] = useState<{ busy: boolean; result?: SimulateResult; error?: string }>({ busy: false });
  const [resetting, setResetting] = useState(false);
  const runLoad = () => {
    setLoad({ busy: true });
    call<LoadDemoResult>('loadDemoData')
      .then((result) => setLoad({ busy: false, result }))
      .catch((e: unknown) => setLoad({ busy: false, error: message(e) }));
  };
  const runSim = () => {
    setSim({ busy: true });
    call<SimulateResult>('simulateBusyMonth')
      .then((result) => setSim({ busy: false, result }))
      .catch((e: unknown) => setSim({ busy: false, error: message(e) }));
  };
  const l = load.result;
  const s = sim.result;
  const busy = load.busy || sim.busy || resetting;
  return (
    <section className="setup__section">
      <h2 className="setup__heading">Demo data</h2>
      <p className="muted">
        Creates the Lumora demo: Jira project SUP with 7 tickets labelled <code>export</code> and 2 labelled <code>billing</code>,
        Confluence space Decisions with eight decision pages from seven teams (label <code>decision</code>), starting with "Defer
        CSV export", and points the settings at SUP. Three pairs of pages contradict each other for the Radar. Safe to run more
        than once.
      </p>
      <button type="button" className="setup__button" onClick={runLoad} disabled={busy}>
        {load.busy ? 'Loading…' : 'Load demo data'}
      </button>
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
      {load.error && (
        <p className="error" role="alert">
          {load.error}
        </p>
      )}
      <p className="muted">
        Adds 30 more <code>export</code> and 6 <code>billing</code> tickets to SUP (once), confirms the proposed tripwires of the
        other seven demo pages you can edit, moves dates and check-ins a month on, then evaluates the Jira-count tripwires twice
        so a crossed threshold trips and opens a Revisit task. The other tripwires are evaluated in the background.
      </p>
      <button type="button" className="setup__button" onClick={runSim} disabled={busy}>
        {sim.busy ? 'Simulating…' : 'Simulate a busy month'}
      </button>
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
      {sim.error && (
        <p className="error" role="alert">
          {sim.error}
        </p>
      )}
      <ResetDemo disabled={load.busy || sim.busy} onBusy={setResetting} />
    </section>
  );
}

mount(
  <Shell title="Tripwire setup">
    <Initialise />
    <SettingsForm />
    <DemoData />
    <RunEvaluation />
    <LlmProbe />
  </Shell>,
);
