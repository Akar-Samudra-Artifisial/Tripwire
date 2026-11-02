import { useCallback, useEffect, useState } from 'react';
import { call } from './bridge';
import { mount } from './mount';
import { ErrorText, Shell, StatusBadge } from './components';

type GraphView =
  | {
      state: 'ok' | 'partial';
      sharedContributors: number;
      contributorsA: number;
      contributorsB: number;
      teamsA: string[];
      teamsB: string[];
      partial?: ('contributors_truncated' | 'teams_failed')[];
    }
  | { state: 'unavailable'; reason: 'no_data' | 'not_indexed' | 'error' | 'no_site' }
  | { state: 'pending' };

interface RadarSide {
  decisionId: string;
  title: string;
  team?: string;
  pageUrl?: string;
}

interface RadarItem {
  id: string;
  a: RadarSide;
  b: RadarSide;
  sharedTopics: string[];
  summary: string;
  confidence: number;
  severity: { score: number; level: 'high' | 'medium' | 'low'; reasons: string[]; graph: boolean };
  graph: GraphView;
  graphStale: boolean;
  detectedAt: string;
}

interface RadarList {
  pairs: RadarItem[];
  hidden: number;
  overview: Record<string, number>;
  lastScan?: { at: string; classified: number; contradictions: number; remaining: number };
  canManage: boolean;
}

const STATES = ['active', 'near', 'tripped', 'revisiting', 'proposed', 'archived'];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const UNAVAILABLE: Record<string, string> = {
  no_data: 'graph context unavailable',
  not_indexed: 'graph context unavailable / not indexed yet',
  error: 'graph context unavailable',
  no_site: 'graph context unavailable',
};

function GraphChip({ graph }: { graph: GraphView }) {
  if (graph.state === 'pending') return <span className="chip muted">Loading graph context…</span>;
  if (graph.state === 'unavailable') return <span className="chip muted">{UNAVAILABLE[graph.reason] ?? 'graph context unavailable'}</span>;
  if (graph.state === 'partial') {
    const truncated = graph.partial?.includes('contributors_truncated');
    return <span className="chip muted">{truncated ? `shared contributors: ${graph.sharedContributors}+ (partial graph context)` : `shared contributors: ${graph.sharedContributors} (partial graph context)`}</span>;
  }
  return <span className="chip">shared contributors: {graph.sharedContributors}</span>;
}

/** Only https links are rendered as links (the URL comes from the Confluence API, but never trust a scheme). */
function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function Side({ side, teams }: { side: RadarSide; teams?: string[] }) {
  const team = side.team ?? teams?.[0];
  const href = safeHref(side.pageUrl);
  return (
    <div className="radar__side">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {side.title}
        </a>
      ) : (
        <span>{side.title}</span>
      )}
      {team && <span className="muted"> · {team}</span>}
    </div>
  );
}

function PairCard({ pair, canManage, onDismiss }: { pair: RadarItem; canManage: boolean; onDismiss: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const teamsA = pair.graph.state === 'ok' || pair.graph.state === 'partial' ? pair.graph.teamsA : undefined;
  const teamsB = pair.graph.state === 'ok' || pair.graph.state === 'partial' ? pair.graph.teamsB : undefined;
  const dismiss = () => {
    setBusy(true);
    onDismiss(pair.id).catch((e: unknown) => {
      setBusy(false);
      setError(message(e));
    });
  };
  return (
    <li className="radar__pair">
      <p>
        <StatusBadge status={`severity-${pair.severity.level}`} /> <span className="muted">confidence {Math.round(pair.confidence * 100)}%</span>
      </p>
      <Side side={pair.a} teams={teamsA} />
      <p className="muted radar__vs">contradicts</p>
      <Side side={pair.b} teams={teamsB} />
      {pair.summary && <p className="radar__summary">{pair.summary}</p>}
      {pair.sharedTopics.length > 0 && <p className="muted">Shared topics: {pair.sharedTopics.join(', ')}</p>}
      <p className="radar__chips">
        <GraphChip graph={pair.graph} />
        {pair.severity.reasons.map((r) => (
          <span key={r} className="chip">
            {r}
          </span>
        ))}
      </p>
      {canManage && (
        <button type="button" className="setup__button" onClick={dismiss} disabled={busy}>
          {busy ? 'Dismissing…' : 'Dismiss'}
        </button>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </li>
  );
}

function useRadar() {
  const [state, setState] = useState<{ data?: RadarList; error?: string; loading: boolean }>({ loading: true });
  const load = useCallback(() => {
    call<RadarList>('radarList')
      .then((data) => setState({ data, loading: false }))
      .catch((e: unknown) => setState({ error: message(e), loading: false }));
  }, []);
  useEffect(load, [load]);

  // Fetch graph context (as the viewer) for pairs whose cache is missing or old, one at a time.
  const stale = state.data?.pairs.filter((p) => p.graphStale).map((p) => p.id).join(',') ?? '';
  useEffect(() => {
    if (stale === '') return;
    let alive = true;
    (async () => {
      for (const pairId of stale.split(',')) {
        try {
          const { pair } = await call<{ pair: RadarItem }>('radarGraphContext', { pairId });
          if (!alive) return;
          setState((s) => (s.data ? { ...s, data: { ...s.data, pairs: s.data.pairs.map((p) => (p.id === pair.id ? pair : p)) } } : s));
        } catch {
          if (!alive) return;
          setState((s) =>
            s.data
              ? { ...s, data: { ...s.data, pairs: s.data.pairs.map((p) => (p.id === pairId ? { ...p, graph: { state: 'unavailable', reason: 'error' }, graphStale: false } : p)) } }
              : s,
          );
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [stale]);

  return { ...state, reload: load, setState };
}

function Radar() {
  const radar = useRadar();
  const [scan, setScan] = useState<{ busy: boolean; queued?: boolean; error?: string }>({ busy: false });
  const scanNow = () => {
    setScan({ busy: true });
    call<{ jobId: string }>('radarScanNow')
      .then(() => setScan({ busy: false, queued: true }))
      .catch((e: unknown) => setScan({ busy: false, error: message(e) }));
  };
  const dismiss = async (pairId: string) => {
    await call('radarDismiss', { pairId });
    radar.setState((s) => (s.data ? { ...s, data: { ...s.data, pairs: s.data.pairs.filter((p) => p.id !== pairId) } } : s));
  };

  if (radar.loading) return <p className="muted">Loading…</p>;
  if (radar.error) return <ErrorText>{radar.error}</ErrorText>;
  const data = radar.data;
  if (!data) return null;
  return (
    <section>
      <p className="muted">Decisions on a shared topic that contradict each other, ranked by confidence, team distance and Teamwork Graph context.</p>
      {data.lastScan && (
        <p className="muted">
          {data.pairs.length + data.hidden} contradiction{data.pairs.length + data.hidden === 1 ? '' : 's'} open. Last scan{' '}
          {new Date(data.lastScan.at).toLocaleString()}:{' '}
          {data.lastScan.classified === 0 && data.lastScan.remaining === 0
            ? 'no new or changed pairs (already assessed pairs are skipped)'
            : `${data.lastScan.classified} new or changed pair${data.lastScan.classified === 1 ? '' : 's'} checked, ${data.lastScan.contradictions} new contradiction${data.lastScan.contradictions === 1 ? '' : 's'}`}
          {data.lastScan.remaining > 0 ? `, ${data.lastScan.remaining} left for the next scan` : ''}.
        </p>
      )}
      {data.canManage && (
        <p>
          <button type="button" className="setup__button" onClick={scanNow} disabled={scan.busy}>
            {scan.busy ? 'Queuing…' : 'Scan now'}
          </button>{' '}
          {scan.queued && (
            <span role="status" className="muted">
              Scan queued. <button type="button" className="link" onClick={radar.reload}>Refresh</button> in a minute.
            </span>
          )}
        </p>
      )}
      {scan.error && <ErrorText>{scan.error}</ErrorText>}
      {data.pairs.length === 0 ? (
        <p>No open contradictions.</p>
      ) : (
        <ul className="radar">
          {data.pairs.map((p) => (
            <PairCard key={p.id} pair={p} canManage={data.canManage} onDismiss={dismiss} />
          ))}
        </ul>
      )}
      {data.hidden > 0 && <p className="muted">{data.hidden} more pairs involve pages you cannot view.</p>}
    </section>
  );
}

function Overview() {
  const [state, setState] = useState<{ data?: Record<string, number>; error?: string }>({});
  useEffect(() => {
    let alive = true;
    call<RadarList>('radarList')
      .then((r) => alive && setState({ data: r.overview }))
      .catch((e: unknown) => alive && setState({ error: message(e) }));
    return () => {
      alive = false;
    };
  }, []);
  if (state.error) return <ErrorText>{state.error}</ErrorText>;
  if (!state.data) return <p className="muted">Loading…</p>;
  const counts = state.data;
  return (
    <ul className="overview">
      {STATES.map((s) => (
        <li key={s}>
          <StatusBadge status={s} /> {counts[s] ?? 0}
        </li>
      ))}
    </ul>
  );
}

function Health() {
  const [tab, setTab] = useState<'overview' | 'radar'>('radar');
  return (
    <Shell title="Decision Health">
      <div className="tabs" role="tablist">
        {(['overview', 'radar'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' tab--active' : ''}`} onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : 'Radar'}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <Overview /> : <Radar />}
    </Shell>
  );
}

mount(<Health />);
