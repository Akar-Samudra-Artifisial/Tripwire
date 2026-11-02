import { useCallback, useEffect, useRef, useState } from 'react';
import { describeSpec, describeValue, formatReading } from '../../src/core/describe';
import type { TripwireKind } from '../../src/core/types';
import { call } from './bridge';
import { ErrorText, Shell, StatusBadge } from './components';
import { mount } from './mount';

interface Decision {
  statement: string;
  extractedAt?: string;
  extractError?: string;
}

interface Tripwire {
  id: string;
  kind: TripwireKind;
  spec: unknown;
  status: string;
  lastValue: number | null;
  lastOutcome: string | null;
  lastEvaluatedAt: string | null;
  confirmedAt?: string | null;
  baselineVersion?: number | null;
}

interface Evaluation {
  id: string;
  value: number | null;
  outcome: string;
  evaluatedAt: string;
}

interface Row {
  assumption: { id: string; quote: string; summary: string };
  tripwire: Tripwire;
  evaluations: Evaluation[];
  revisit?: { issueKey: string };
}

interface DecisionView {
  decision?: Decision;
  assumptions: Row[];
  state: 'none' | 'ready' | 'error';
  canEdit: boolean;
}

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 90_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "7 / > 10 · safe · measured 2026-11-02" for numeric tripwires; for the others the kind's own reading, e.g.
 * "3 days left until 2027-03-31 (measured 2026-11-02) · near" or "check-in overdue by 1 day (measured …) · tripped".
 */
function Reading({ tripwire }: { tripwire: Tripwire }) {
  if (tripwire.kind !== 'jql_threshold' && tripwire.kind !== 'graph_relation') {
    if (tripwire.lastValue === null && !(tripwire.kind === 'checkin' && tripwire.confirmedAt)) return null;
    const parts = [formatReading(tripwire), tripwire.lastOutcome ?? undefined].filter(Boolean);
    return <p className="muted">{parts.join(' · ')}</p>;
  }
  if (tripwire.lastOutcome === null && tripwire.lastValue === null) return null;
  const spec = tripwire.spec as { op?: string; value?: number };
  const numeric = tripwire.kind === 'jql_threshold' && tripwire.lastValue !== null;
  const parts = [
    numeric ? `${tripwire.lastValue} / ${spec.op} ${spec.value}` : undefined,
    tripwire.lastOutcome ?? undefined,
    tripwire.lastEvaluatedAt ? `measured ${tripwire.lastEvaluatedAt.slice(0, 10)}` : undefined,
  ].filter(Boolean);
  return <p className="muted">{parts.join(' · ')}</p>;
}

/** Last evaluations, newest first. */
function Trend({ tripwire, evaluations }: { tripwire: Tripwire; evaluations: Evaluation[] }) {
  if (evaluations.length === 0) return null;
  return (
    <details className="trend">
      <summary>Last {evaluations.length} evaluations</summary>
      <ul className="trend__list">
        {evaluations.map((e) => (
          <li key={e.id}>
            {e.evaluatedAt.slice(0, 10)} · {describeValue(tripwire.kind, tripwire.spec, e.value)} · {e.outcome}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AssumptionItem({ row, canEdit, onChanged }: { row: Row; canEdit: boolean; onChanged: () => void }) {
  const { assumption, tripwire } = row;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(tripwire.spec, null, 2));
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });

  const confirm = (action: 'accept' | 'edit' | 'checkin') => {
    let spec: unknown;
    if (action === 'edit') {
      try {
        spec = JSON.parse(draft);
      } catch {
        setState({ busy: false, error: 'The spec is not valid JSON.' });
        return;
      }
    }
    setState({ busy: true });
    call<{ tripwire: Tripwire }>('confirmTripwire', { tripwireId: tripwire.id, action, ...(action === 'edit' ? { spec } : {}) })
      .then(() => {
        setState({ busy: false });
        setEditing(false);
        onChanged();
      })
      .catch((e: unknown) => setState({ busy: false, error: message(e) }));
  };

  return (
    <li className="assumption">
      <blockquote className="assumption__quote">{assumption.quote}</blockquote>
      <p>
        {assumption.summary} <StatusBadge status={tripwire.status} />
      </p>
      <p className="muted">
        <code>{tripwire.kind}</code> · {describeSpec(tripwire.kind, tripwire.spec)}
      </p>
      <Reading tripwire={tripwire} />
      {row.revisit && <p className="muted">Revisit task: {row.revisit.issueKey}</p>}
      <Trend tripwire={row.tripwire} evaluations={row.evaluations} />
      {canEdit && tripwire.status === 'proposed' && (
        <div className="assumption__actions">
          <button type="button" onClick={() => confirm('accept')} disabled={state.busy}>
            Accept
          </button>
          <button type="button" onClick={() => setEditing(!editing)} disabled={state.busy}>
            Edit
          </button>
          <button type="button" onClick={() => confirm('checkin')} disabled={state.busy}>
            Check-in
          </button>
        </div>
      )}
      {editing && (
        <div className="assumption__edit">
          <textarea aria-label="Tripwire spec (JSON)" value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} />
          <button type="button" onClick={() => confirm('edit')} disabled={state.busy}>
            Save and accept
          </button>
        </div>
      )}
      {state.error && <ErrorText>{state.error}</ErrorText>}
    </li>
  );
}

function Byline() {
  const [view, setView] = useState<DecisionView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [scanning, setScanning] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(
    () =>
      call<DecisionView>('getDecision')
        .then((v) => {
          setView(v);
          setError(undefined);
          return v;
        })
        .catch((e: unknown) => {
          setError(message(e));
          return undefined;
        }),
    [],
  );

  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  const scan = (force: boolean) => {
    const before = view?.decision;
    const started = Date.now();
    setScanning(true);
    setError(undefined);
    const poll = () => {
      void load().then((v) => {
        const d = v?.decision;
        const changed = d && (d.extractedAt !== before?.extractedAt || (d.extractError && d.extractError !== before?.extractError));
        if (changed) setScanning(false);
        else if (Date.now() - started > POLL_LIMIT_MS) {
          setScanning(false);
          setError('Scanning is taking longer than expected. Reload the page later.');
        } else timer.current = window.setTimeout(poll, POLL_MS);
      });
    };
    call<{ jobId: string }>('scanPage', { force })
      .then(() => {
        timer.current = window.setTimeout(poll, POLL_MS);
      })
      .catch((e: unknown) => {
        setScanning(false);
        setError(message(e));
      });
  };

  if (!view && !error) return <p className="muted">Loading…</p>;
  const decision = view?.decision;
  const hasResult = view?.state === 'ready' || (view?.assumptions.length ?? 0) > 0;

  return (
    <section>
      {decision?.statement && <p className="decision__statement">{decision.statement}</p>}
      {view?.state === 'error' && decision?.extractError && <ErrorText>Last scan failed: {decision.extractError}</ErrorText>}
      {view && !hasResult && <p className="muted">No assumptions recorded for this page yet.</p>}
      {hasResult && view?.assumptions.length === 0 && <p className="muted">No assumptions were found on this page.</p>}
      {view && view.assumptions.length > 0 && (
        <ul className="assumptions">
          {view.assumptions.map((row) => (
            <AssumptionItem key={row.tripwire.id} row={row} canEdit={view.canEdit} onChanged={() => void load()} />
          ))}
        </ul>
      )}
      {scanning && <p role="status">Scanning… this can take up to a minute.</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {view?.canEdit && (
        <>
          <button type="button" className="setup__button" onClick={() => scan(hasResult)} disabled={scanning}>
            {hasResult ? 'Re-scan' : 'Scan this page'}
          </button>
          {hasResult && <p className="muted">Re-scan replaces only tripwires that are still proposed.</p>}
        </>
      )}
    </section>
  );
}

mount(
  <Shell title="Tripwire">
    <Byline />
  </Shell>,
);
