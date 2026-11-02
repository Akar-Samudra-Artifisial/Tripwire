/** Decision Health → Radar tab: open contradiction pairs the user may see, ranked with Teamwork Graph context. */
import type { Repo } from '../adapters/repo';
import { rankSeverity, type PairGraph, type PartialReason, type RadarDecisionSummary, type RadarPairView, type Severity } from '../core/radar';
import type { TripwireStatus } from '../core/types';

/** Graph context older than this is fetched again when the Radar is opened. */
export const GRAPH_TTL_MS = 24 * 60 * 60 * 1000;
/** "unavailable" / "partial" is retried soon: a fresh human edit is usually indexed within minutes. The per-pair cooldown still caps fan-out. */
export const GRAPH_UNAVAILABLE_TTL_MS = 2 * 60 * 1000;
/** Per-pair cooldown between Teamwork Graph fetches, so repeated refreshes cannot fan out graph queries. */
export const GRAPH_FETCH_COOLDOWN_SECONDS = 60;
/** Must pass `appKey` in repo.ts (`^[a-z][a-z0-9-]{0,63}$`): no ':' and lower case (pair ids are UUIDs, 48 chars). */
export const graphLockName = (pairId: string): string => `radar-graph-${pairId.toLowerCase()}`;
/** Open pairs read before the per-user page filter. */
const RADAR_SCAN_LIMIT = 100;
/** Pairs shown. */
export const RADAR_LIST_LIMIT = 30;
const VIEW_BATCH = 10;

export type GraphView =
  | {
      state: 'ok' | 'partial';
      sharedContributors: number;
      contributorsA: number;
      contributorsB: number;
      teamsA: string[];
      teamsB: string[];
      partial?: PartialReason[];
    }
  | { state: 'unavailable'; reason: 'no_data' | 'not_indexed' | 'error' | 'no_site' }
  | { state: 'pending' };

export interface RadarSide {
  decisionId: string;
  title: string;
  team?: string;
  pageUrl?: string;
}

export interface RadarItem {
  id: string;
  a: RadarSide;
  b: RadarSide;
  sharedTopics: string[];
  summary: string;
  confidence: number;
  severity: Severity;
  graph: GraphView;
  /** True when the Radar should ask `radarGraphContext` for fresh graph context. */
  graphStale: boolean;
  detectedAt: string;
}

export interface RadarListResult {
  pairs: RadarItem[];
  /** Pairs hidden because the user cannot view one of the pages (titles never revealed). */
  hidden: number;
  overview: Partial<Record<TripwireStatus, number>>;
  lastScan?: { at: string; classified: number; contradictions: number; remaining: number };
  canManage: boolean;
}

type ViewedPage = { title: string; webUrl?: string };

export interface RadarViewDeps {
  repo: Pick<Repo, 'listRadarPairs' | 'getRadarPair' | 'countTripwiresByStatus' | 'getAppValue' | 'updateRadarPairGraph' | 'acquireAppLock'>;
  /** The page as the calling user sees it; undefined when they cannot view it. */
  viewPage: (pageId: string) => Promise<ViewedPage | undefined>;
  /** Errors to rethrow instead of hiding the page (e.g. missing user consent, so the bridge can prompt). */
  isPlatformError: (err: unknown) => boolean;
  now: () => Date;
}

export class RadarNotFoundError extends Error {}

/** Whether the cached graph should be fetched again. */
export function graphStale(graph: PairGraph | null, fetchedAt: string | null, now: Date): boolean {
  if (!graph || !fetchedAt) return true;
  const age = now.getTime() - Date.parse(fetchedAt);
  if (!Number.isFinite(age)) return true;
  return age > (graph.state === 'ok' ? GRAPH_TTL_MS : GRAPH_UNAVAILABLE_TTL_MS);
}

/** Counts and team names only (the cache never holds contributor account ids). */
export function toGraphView(graph: PairGraph | null): GraphView {
  if (!graph) return { state: 'pending' };
  if (graph.state === 'unavailable') return { state: 'unavailable', reason: graph.reason };
  return {
    state: graph.state,
    sharedContributors: graph.sharedContributors,
    contributorsA: graph.contributorsA,
    contributorsB: graph.contributorsB,
    teamsA: graph.teamsA,
    teamsB: graph.teamsB,
    ...(graph.partial ? { partial: graph.partial } : {}),
  };
}

const side = (d: RadarDecisionSummary, page: ViewedPage): RadarSide => ({
  decisionId: d.id,
  title: page.title || d.title || d.statement.slice(0, 120) || 'Untitled decision',
  ...(d.team ? { team: d.team } : {}),
  ...(page.webUrl ? { pageUrl: page.webUrl } : {}),
});

export function toRadarItem(view: RadarPairView, pageA: ViewedPage, pageB: ViewedPage, now: Date): RadarItem {
  const { pair } = view;
  return {
    id: pair.id,
    a: side(view.a, pageA),
    b: side(view.b, pageB),
    sharedTopics: pair.sharedTopics,
    summary: pair.summary,
    confidence: pair.confidence,
    severity: rankSeverity(pair, { a: view.a.team, b: view.b.team }, pair.graph),
    graph: toGraphView(pair.graph),
    graphStale: graphStale(pair.graph, pair.graphFetchedAt, now),
    detectedAt: pair.detectedAt,
  };
}

/** Both pages as the user sees them, or undefined when either is hidden (fail closed: a failed check hides). */
async function viewBoth(view: RadarPairView, viewOnce: (pageId: string) => Promise<ViewedPage | undefined>): Promise<[ViewedPage, ViewedPage] | undefined> {
  const [a, b] = await Promise.all([viewOnce(view.a.pageId), viewOnce(view.b.pageId)]);
  return a && b ? [a, b] : undefined;
}

function cachedViewer(deps: RadarViewDeps): (pageId: string) => Promise<ViewedPage | undefined> {
  const cache = new Map<string, Promise<ViewedPage | undefined>>();
  return (pageId) => {
    let found = cache.get(pageId);
    if (!found) {
      found = deps.viewPage(pageId).catch((err: unknown) => {
        if (deps.isPlatformError(err)) throw err;
        console.warn('tripwire radar: page access check failed, hiding pair', { pageId, error: err instanceof Error ? err.message : String(err) });
        return undefined;
      });
      cache.set(pageId, found);
    }
    return found;
  };
}

function readLastScan(raw: unknown): RadarListResult['lastScan'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.at !== 'string') return undefined;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { at: v.at, classified: n(v.classified), contradictions: n(v.contradictions), remaining: n(v.remaining) };
}

/** Open pairs whose two pages the user can view, highest severity first. */
export async function radarListWith(deps: RadarViewDeps, canManage: boolean, lastScanKey: string): Promise<RadarListResult> {
  const [views, overview, lastScan] = await Promise.all([
    deps.repo.listRadarPairs(['open'], RADAR_SCAN_LIMIT),
    deps.repo.countTripwiresByStatus(),
    deps.repo.getAppValue(lastScanKey),
  ]);
  const viewOnce = cachedViewer(deps);
  const now = deps.now();
  const pairs: RadarItem[] = [];
  let hidden = 0;
  for (let i = 0; i < views.length; i += VIEW_BATCH) {
    const batch = views.slice(i, i + VIEW_BATCH);
    const pages = await Promise.all(batch.map((v) => viewBoth(v, viewOnce)));
    for (const [j, v] of batch.entries()) {
      const both = pages[j];
      if (!both) {
        hidden += 1;
        continue;
      }
      pairs.push(toRadarItem(v, both[0], both[1], now));
    }
  }
  pairs.sort((x, y) => y.severity.score - x.severity.score || y.confidence - x.confidence);
  const scan = readLastScan(lastScan);
  console.info('tripwire radar list', { open: views.length, shown: Math.min(pairs.length, RADAR_LIST_LIMIT), hidden });
  return { pairs: pairs.slice(0, RADAR_LIST_LIMIT), hidden, overview, ...(scan ? { lastScan: scan } : {}), canManage };
}

/**
 * Graph context for one pair the user can see: the cached value while fresh, otherwise fetched with `fetchGraph`
 * (as the user) and cached. At most one fetch per pair per `GRAPH_FETCH_COOLDOWN_SECONDS` (otherwise the cache
 * is returned as is). A partial/unavailable result never replaces a still-fresh `ok` cache. `fetchGraph`
 * undefined means the site id is unknown: shown as unavailable, not cached.
 */
export async function radarGraphContextWith(
  pairId: string,
  deps: RadarViewDeps,
  fetchGraph: ((pageA: string, pageB: string) => Promise<PairGraph>) | undefined,
): Promise<RadarItem> {
  const view = await deps.repo.getRadarPair(pairId);
  if (!view) throw new RadarNotFoundError('This Radar pair no longer exists.');
  const both = await viewBoth(view, cachedViewer(deps));
  // Same message as a missing pair: never confirm that a hidden pair exists.
  if (!both) throw new RadarNotFoundError('This Radar pair no longer exists.');
  const now = deps.now();
  if (!graphStale(view.pair.graph, view.pair.graphFetchedAt, now)) return toRadarItem(view, both[0], both[1], now);
  if (!fetchGraph) {
    return { ...toRadarItem(view, both[0], both[1], now), graph: { state: 'unavailable', reason: 'no_site' }, graphStale: false };
  }
  // Cooldown lock, never released: it expires after the cooldown.
  if (!(await deps.repo.acquireAppLock(graphLockName(pairId), now.toISOString(), GRAPH_FETCH_COOLDOWN_SECONDS))) {
    console.info('tripwire radar graph', { pairId, throttled: true });
    return { ...toRadarItem(view, both[0], both[1], now), graphStale: false };
  }
  const graph = await fetchGraph(view.a.pageId, view.b.pageId);
  const fetchedAt = now.toISOString();
  const keepOkSince = new Date(now.getTime() - GRAPH_TTL_MS).toISOString();
  const written = await deps.repo.updateRadarPairGraph(pairId, graph, fetchedAt, keepOkSince);
  console.info('tripwire radar graph', {
    pairId,
    state: graph.state,
    written,
    ...(graph.state === 'unavailable' ? { reason: graph.reason } : { shared: graph.sharedContributors, partial: graph.partial }),
  });
  if (!written) {
    const current = (await deps.repo.getRadarPair(pairId)) ?? view;
    return { ...toRadarItem(current, both[0], both[1], now), graphStale: false };
  }
  const updated: RadarPairView = { ...view, pair: { ...view.pair, graph, graphFetchedAt: fetchedAt } };
  return toRadarItem(updated, both[0], both[1], now);
}
