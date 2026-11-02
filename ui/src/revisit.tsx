import { describeSpec, formatReading } from '../../src/core/describe';
import type { TripwireKind } from '../../src/core/types';
import { useRemote } from './bridge';
import { Shell, StatusBadge } from './components';
import { mount } from './mount';

interface RevisitView {
  revisit: { issueKey: string; status: string; createdAt: string };
  decision: { statement: string; title?: string };
  assumption: { quote: string; summary: string };
  tripwire: { kind: TripwireKind; spec: unknown; status: string; strikes: number; lastValue: number | null; lastEvaluatedAt: string | null };
  evaluations: { id: string; value: number | null; outcome: string; evaluatedAt: string }[];
  pageUrl?: string;
}

function Revisit() {
  const { data, error, loading } = useRemote<RevisitView>('getRevisit');
  if (loading) return <p className="muted">Loading…</p>;
  if (error || !data) return <p className="muted">{error ?? 'This work item is not a Tripwire revisit task.'}</p>;
  const { decision, assumption, tripwire, evaluations, pageUrl } = data;
  return (
    <section>
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
        Tripwire <StatusBadge status={tripwire.status} />
      </h2>
      <p className="muted">{describeSpec(tripwire.kind, tripwire.spec)}</p>
      <p>Now {formatReading(tripwire)}</p>
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
      <div className="assumption__actions">
        <button type="button" disabled title="Coming soon">
          Reaffirm (coming soon)
        </button>
        <button type="button" disabled title="Coming soon">
          Supersede (coming soon)
        </button>
      </div>
    </section>
  );
}

mount(
  <Shell title="Decision revisit">
    <Revisit />
  </Shell>,
);
