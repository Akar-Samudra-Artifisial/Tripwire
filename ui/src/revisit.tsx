import { useEffect, useState } from 'react';
import { describeSpec, formatReading } from '../../src/core/describe';
import type { TripwireKind } from '../../src/core/types';
import { call, useRemote } from './bridge';
import { ErrorText, Shell, StatusBadge } from './components';
import { mount } from './mount';

interface RestrictedView {
  restricted: true;
  message: string;
  revisit: { issueKey: string; status: string };
}

interface RevisitView {
  restricted?: undefined;
  revisit: { issueKey: string; status: string; createdAt: string; outcome?: string; newThreshold?: number };
  decision: { statement: string; title?: string };
  assumption: { quote: string; summary: string };
  tripwire: { kind: TripwireKind; spec: unknown; status: string; strikes: number; lastValue: number | null; lastEvaluatedAt: string | null };
  evaluations: { id: string; value: number | null; outcome: string; evaluatedAt: string }[];
  pageUrl?: string;
  suggestedThreshold?: number;
}

interface ReaffirmResult {
  reaffirmed: true;
  issueKey: string;
  oldThreshold: number;
  newThreshold: number;
  status: 'active';
  warnings: string[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Reaffirm({ view, onDone }: { view: RevisitView; onDone: (r: ReaffirmResult) => void }) {
  const [threshold, setThreshold] = useState(view.suggestedThreshold === undefined ? '' : String(view.suggestedThreshold));
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const current = (view.tripwire.spec as { op?: string; value?: number } | null) ?? {};
  const parsed = threshold.trim() === '' ? NaN : Number(threshold);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000;

  useEffect(() => setConfirming(false), [threshold]);

  const submit = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setState({ busy: true });
    call<ReaffirmResult>('reaffirmRevisit', { newThreshold: parsed, note })
      .then((r) => {
        setState({ busy: false });
        onDone(r);
      })
      .catch((e: unknown) => {
        setState({ busy: false, error: message(e) });
        setConfirming(false);
      });
  };

  return (
    <div className="setup__form">
      <label>
        New threshold (now {String(current.op)} {String(current.value)})
        <input
          type="number"
          min={0}
          max={1000000}
          step="any"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          disabled={state.busy}
          aria-invalid={!valid}
        />
      </label>
      <label>
        Note (optional)
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} disabled={state.busy} />
      </label>
      <div className="assumption__actions">
        <button type="button" className="setup__button" onClick={submit} disabled={!valid || state.busy}>
          {state.busy ? 'Reaffirming…' : confirming ? `Confirm: threshold ${String(current.op)} ${parsed}` : 'Reaffirm'}
        </button>
        {confirming && !state.busy && (
          <button type="button" className="setup__button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        )}
        <button type="button" disabled title="Coming soon">
          Supersede (coming soon)
        </button>
      </div>
      {confirming && !state.busy && (
        <p className="muted">The decision stands, the tripwire becomes active with the new threshold and this work item moves to Done.</p>
      )}
      {!valid && threshold.trim() !== '' && <ErrorText>Enter a number between 0 and 1000000.</ErrorText>}
      {state.error && <ErrorText>{state.error}</ErrorText>}
    </div>
  );
}

function Revisit() {
  const { data, error, loading } = useRemote<RevisitView | RestrictedView>('getRevisit');
  const [result, setResult] = useState<ReaffirmResult | undefined>();
  if (loading) return <p className="muted">Loading…</p>;
  if (error || !data) return <p className="muted">{error ?? 'This work item is not a Tripwire revisit task.'}</p>;
  if (data.restricted) {
    return (
      <section>
        <h2 className="setup__heading">
          Revisit <StatusBadge status={data.revisit.status === 'closed' ? 'closed' : 'open'} />
        </h2>
        <p className="muted">{data.message}</p>
      </section>
    );
  }
  const { decision, assumption, tripwire, evaluations, pageUrl, revisit } = data;
  const closed = revisit.status === 'closed' || result !== undefined;
  const numeric = tripwire.kind === 'jql_threshold' || tripwire.kind === 'graph_relation';
  return (
    <section>
      <h2 className="setup__heading">
        Revisit <StatusBadge status={closed ? 'closed' : 'open'} />
      </h2>
      <h2 className="setup__heading">Decision</h2>
      <p className="decision__statement">{decision.statement || decision.title}</p>
      {pageUrl && (
        <p>
          <a href={pageUrl} target="_blank" rel="noreferrer">
            Open decision page
          </a>
        </p>
      )}
      <h2 className="setup__heading">Assumption</h2>
      <blockquote className="assumption__quote">{assumption.quote}</blockquote>
      <p>{assumption.summary}</p>
      <h2 className="setup__heading">
        Tripwire <StatusBadge status={result ? result.status : tripwire.status} />
      </h2>
      <p className="muted">{describeSpec(tripwire.kind, result ? { ...(tripwire.spec as object), value: result.newThreshold } : tripwire.spec)}</p>
      <p>Now {formatReading(result ? { ...tripwire, spec: { ...(tripwire.spec as object), value: result.newThreshold } } : tripwire)}</p>
      <h2 className="setup__heading">Trend</h2>
      {evaluations.length === 0 ? (
        <p className="muted">No evaluations recorded.</p>
      ) : (
        <ul className="trend__list">
          {evaluations.map((e) => (
            <li key={e.id}>
              {e.evaluatedAt.slice(0, 10)} · {e.value ?? '—'} · {e.outcome}
            </li>
          ))}
        </ul>
      )}
      {result && (
        <>
          <p role="status">
            Reaffirmed: threshold {result.oldThreshold} → {result.newThreshold}. The tripwire is active again and the revisit is CLOSED.
          </p>
          {result.warnings.map((w) => (
            <ErrorText key={w}>{w}</ErrorText>
          ))}
        </>
      )}
      {!result && closed && (
        <p role="status">
          CLOSED{revisit.outcome ? ` · ${revisit.outcome}` : ''}
          {revisit.newThreshold !== undefined ? ` · new threshold ${revisit.newThreshold}` : ''}
        </p>
      )}
      {!closed && numeric && <Reaffirm view={data} onDone={setResult} />}
      {!closed && !numeric && (
        <div className="assumption__actions">
          <button type="button" disabled title="Only numeric tripwires can be reaffirmed with a new threshold">
            Reaffirm (numeric tripwires only)
          </button>
          <button type="button" disabled title="Coming soon">
            Supersede (coming soon)
          </button>
        </div>
      )}
    </section>
  );
}

mount(
  <Shell title="Decision revisit">
    <Revisit />
  </Shell>,
);
