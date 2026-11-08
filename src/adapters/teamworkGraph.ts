import api from '@forge/api';
import type { PairGraph, PartialReason, SpaceTeams } from '../core/radar';

/**
 * Teamwork Graph reads (Preview, read-only). Queries go through `asUser().requestTeamworkGraph()`, so they only
 * run from resolvers (not from queue consumers or scheduled triggers). A missing scope or query context returns
 * `data: null`, and a page that is not indexed yet returns no contributors: neither means "no relations".
 * Every read is logged with its raw edge count, null nodes and GraphQL errors (also when `data` is present).
 */
export class GraphNotImplementedError extends Error {
  constructor(what: string) {
    super(`Teamwork Graph ${what} is not implemented yet`);
    this.name = 'GraphNotImplementedError';
  }
}

// Operation names must be `<company>_<operation>`; `first` is at most 25. Names are not requested: only account
// ids are read, to count contributors and look up their teams, and they are never stored.
export const PAGE_CONTRIBUTORS_QUERY = `query tripwire_pageContributors($id: ID!) {
  confluencePageContributors(id: $id, first: 25) {
    edges { node { __typename ... on AtlassianUser { id accountId } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Follow-up pages of `PAGE_CONTRIBUTORS_QUERY`. */
export const PAGE_CONTRIBUTORS_NEXT_QUERY = `query tripwire_pageContributorsNext($id: ID!, $after: String!) {
  confluencePageContributors(id: $id, first: 25, after: $after) {
    edges { node { __typename ... on AtlassianUser { id accountId } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Most contributor pages (of 25) read per Confluence page; more than that is marked `contributors_truncated`. */
export const MAX_CONTRIBUTOR_PAGES = 4;

export const USER_TEAMS_QUERY = `query tripwire_userTeams($userId: ID!) {
  atlassianUserInTeams(userId: $userId, first: 25) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
  }
}`;

/** Teams linked to a Confluence space (the space's team link in Teamwork Graph). An unlinked space answers 0 edges. */
export const SPACE_TEAMS_QUERY = `query tripwire_spaceTeams($spaceAri: ID!) {
  atlassianTeamsBySpace(spaceAri: $spaceAri, first: 25) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
  }
}`;

export const pageAri = (cloudId: string, pageId: string): string => `ari:cloud:confluence:${cloudId}:page/${pageId}`;
export const spaceAri = (cloudId: string, spaceId: string): string => `ari:cloud:confluence:${cloudId}:space/${spaceId}`;
export const userAri = (accountId: string): string => `ari:cloud:identity::user/${accountId}`;
/** Value of the `X-Query-Context` header; without it the endpoint answers `data: null`. */
export const queryContext = (cloudId: string): string => `ari:cloud:platform::site/${cloudId}`;

/** `ari:cloud:confluence::site/<cloudId>` (resolver `installContext`) → cloudId. */
export function cloudIdFromInstallContext(installContext: string | undefined): string | undefined {
  const m = /^ari:cloud:[a-z-]+::site\/([0-9a-f-]{8,64})$/i.exec(installContext ?? '');
  return m?.[1];
}

/** What a response held besides the usable nodes: raw edges, null nodes and GraphQL errors (also next to data). */
export interface GraphMeta {
  rawCount: number;
  nullNodes: number;
  errorCount: number;
  /** First `MAX_LOGGED_ERRORS` GraphQL error messages, each cut to `ERROR_TEXT_LIMIT` characters. */
  errors: string[];
}

export type GraphRead<T> = ({ ok: true; value: T } | { ok: false; reason: 'no_data' }) & { meta: GraphMeta };

const ERROR_TEXT_LIMIT = 200;
const MAX_LOGGED_ERRORS = 3;

interface GraphBody {
  data?: Record<
    string,
    { edges?: ({ node?: Record<string, unknown> | null } | null)[] | null; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null } | null
  > | null;
  errors?: { message?: unknown }[];
}

/**
 * Error text safe for logs: ARIs (which can carry account ids) and bare account ids are replaced before the text
 * is cut to `ERROR_TEXT_LIMIT` characters.
 */
export function scrubErrorText(text: string): string {
  return text
    .replace(/ari:cloud:[^\s'"`,)\]}]+/gi, '<ari>')
    .replace(/\b\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<accountId>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<accountId>')
    .slice(0, ERROR_TEXT_LIMIT);
}

function edgesOf(raw: unknown, field: string): GraphRead<Record<string, unknown>[]> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as GraphBody;
  const all = Array.isArray(body.errors) ? body.errors : [];
  const errors = all.slice(0, MAX_LOGGED_ERRORS).map((e) => (typeof e?.message === 'string' ? scrubErrorText(e.message) : 'error without message'));
  const connection = body.data?.[field];
  if (!connection || !Array.isArray(connection.edges)) return { ok: false, reason: 'no_data', meta: { rawCount: 0, nullNodes: 0, errorCount: all.length, errors } };
  const nodes = connection.edges.map((e) => e?.node);
  const kept = nodes.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object');
  return { ok: true, value: kept, meta: { rawCount: nodes.length, nullNodes: nodes.length - kept.length, errorCount: all.length, errors } };
}

export interface ContributorPage {
  ids: string[];
  /** Cursor of the next page, when there is one. */
  next?: string;
}

/**
 * Contributor account ids (and the next-page cursor) from a `tripwire_pageContributors` response; `no_data` when
 * `data` (or the field) is null. Null user nodes are counted in `meta.nullNodes`, never silently dropped.
 */
export function parseContributors(raw: unknown): GraphRead<ContributorPage> {
  const nodes = edgesOf(raw, 'confluencePageContributors');
  if (!nodes.ok) return nodes;
  const ids = nodes.value
    .map((n) => (typeof n.accountId === 'string' ? n.accountId : typeof n.id === 'string' ? (/user\/([^/]+)$/.exec(n.id)?.[1] ?? '') : ''))
    .filter((id) => id !== '');
  const info = (raw as GraphBody).data?.confluencePageContributors?.pageInfo;
  const next = info?.hasNextPage === true && typeof info.endCursor === 'string' && info.endCursor !== '' ? info.endCursor : undefined;
  return { ok: true, value: { ids: [...new Set(ids)], ...(next ? { next } : {}) }, meta: nodes.meta };
}

export type Team = { id: string; name: string };

function teamsFrom(raw: unknown, field: string): GraphRead<Team[]> {
  const nodes = edgesOf(raw, field);
  if (!nodes.ok) return nodes;
  return {
    ok: true,
    value: nodes.value
      .filter((n) => typeof n.id === 'string' && n.id !== '')
      .map((n) => ({ id: String(n.id), name: typeof n.displayName === 'string' ? n.displayName.slice(0, 120) : 'Unnamed team' })),
    meta: nodes.meta,
  };
}

/** Teams from a `tripwire_userTeams` response. */
export const parseTeams = (raw: unknown): GraphRead<Team[]> => teamsFrom(raw, 'atlassianUserInTeams');

/** Teams from a `tripwire_spaceTeams` response; an empty list means no team is linked to the space. */
export const parseSpaceTeams = (raw: unknown): GraphRead<Team[]> => teamsFrom(raw, 'atlassianTeamsBySpace');

/** Sends one query; resolves to the parsed JSON body. Throws on a non-2xx response. */
export type GraphRequest = (query: string, variables: Record<string, unknown>, operationName: string) => Promise<unknown>;

/** `requestTeamworkGraph` as the current user, with the site query context. Resolver only. */
export function asUserGraph(cloudId: string): GraphRequest {
  return async (query, variables, operationName) => {
    const res = await api.asUser().requestTeamworkGraph(query, variables, operationName, undefined, { 'X-Query-Context': queryContext(cloudId) });
    if (!res.ok) throw new Error(`Teamwork Graph ${operationName} failed: HTTP ${res.status}`);
    return res.json();
  };
}

/** Most contributors per page whose teams are looked up (one query each). */
export const TEAM_LOOKUPS_PER_PAGE = 5;

const log = (op: string, fields: Record<string, unknown>): void => {
  // Counts, ids of pages/spaces and error text only; never page content, names or account ids.
  console.info('tripwire twg', { op, ...fields });
};

/** One structured line per read: op, rawCount, nullNodes, count and GraphQL errors, whether or not data came back. */
const logRead = (op: string, fields: Record<string, unknown>, read: GraphRead<unknown>, count: number): void =>
  log(op, { ...fields, data: read.ok, rawCount: read.meta.rawCount, nullNodes: read.meta.nullNodes, count, errorCount: read.meta.errorCount, errors: read.meta.errors });

const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : String(err));

type Contributors = { ok: true; ids: string[]; truncated: boolean; nullNodes: number } | { ok: false; reason: 'no_data' | 'error' };

/**
 * All contributors of a page, following `hasNextPage` for at most `MAX_CONTRIBUTOR_PAGES` pages. A list still cut
 * off after that, or a follow-up page that fails, is `truncated`: its "shared contributors" count is a lower bound.
 */
async function contributorsOf(request: GraphRequest, cloudId: string, pageId: string): Promise<Contributors> {
  const id = pageAri(cloudId, pageId);
  let first: GraphRead<ContributorPage>;
  try {
    first = parseContributors(await request(PAGE_CONTRIBUTORS_QUERY, { id }, 'tripwire_pageContributors'));
  } catch (err) {
    log('tripwire_pageContributors', { pageId, failed: true, message: errorText(err) });
    return { ok: false, reason: 'error' };
  }
  logRead('tripwire_pageContributors', { pageId }, first, first.ok ? first.value.ids.length : 0);
  if (!first.ok) return { ok: false, reason: 'no_data' };
  const ids = new Set(first.value.ids);
  let nullNodes = first.meta.nullNodes;
  let next = first.value.next;
  let pages = 1;
  let failed = false;
  while (next && pages < MAX_CONTRIBUTOR_PAGES) {
    pages += 1;
    try {
      const page = parseContributors(await request(PAGE_CONTRIBUTORS_NEXT_QUERY, { id, after: next }, 'tripwire_pageContributorsNext'));
      logRead('tripwire_pageContributorsNext', { pageId, page: pages }, page, page.ok ? page.value.ids.length : 0);
      if (!page.ok) {
        failed = true;
        break;
      }
      for (const x of page.value.ids) ids.add(x);
      nullNodes += page.meta.nullNodes;
      next = page.value.next;
    } catch (err) {
      log('tripwire_pageContributorsNext', { pageId, failed: true, message: errorText(err) });
      failed = true;
      break;
    }
  }
  const truncated = failed || next !== undefined;
  if (pages > 1) log('tripwire_pageContributors', { pageId, total: ids.size, nullNodes, pages, truncated });
  return { ok: true, ids: [...ids], truncated, nullNodes };
}

/** Teams of `accountIds`, deduplicated; `failed` when any lookup failed or returned no data. */
async function teamsOf(request: GraphRequest, accountIds: readonly string[]): Promise<{ teams: Team[]; failed: boolean }> {
  let failed = false;
  const lists = await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        const result = parseTeams(await request(USER_TEAMS_QUERY, { userId: userAri(accountId) }, 'tripwire_userTeams'));
        logRead('tripwire_userTeams', {}, result, result.ok ? result.value.length : 0);
        if (!result.ok) failed = true;
        return result.ok ? result.value : [];
      } catch (err) {
        log('tripwire_userTeams', { failed: true, message: errorText(err) });
        failed = true;
        return [];
      }
    }),
  );
  const byId = new Map<string, Team>();
  for (const t of lists.flat()) byId.set(t.id, t);
  return { teams: [...byId.values()], failed };
}

/** Teams linked to a space; null when the graph returned no data or the call failed. */
async function spaceTeamsOf(request: GraphRequest, cloudId: string, spaceId: string): Promise<Team[] | null> {
  try {
    const result = parseSpaceTeams(await request(SPACE_TEAMS_QUERY, { spaceAri: spaceAri(cloudId, spaceId) }, 'tripwire_spaceTeams'));
    logRead('tripwire_spaceTeams', { spaceId }, result, result.ok ? result.value.length : 0);
    return result.ok ? result.value : null;
  } catch (err) {
    log('tripwire_spaceTeams', { spaceId, failed: true, message: errorText(err) });
    return null;
  }
}

/** Space id of a page; undefined when unknown. */
export type SpaceOf = (pageId: string) => Promise<string | undefined>;

/**
 * Teams linked to the spaces of both pages, one lookup per space id. Context only: a space's team says who owns the
 * space, not who wrote the decision, so it never decides "same team" or "different teams".
 */
export async function fetchSpaceTeams(request: GraphRequest, cloudId: string, pageA: string, pageB: string, spaceOf: SpaceOf): Promise<SpaceTeams> {
  const space = (pageId: string) =>
    spaceOf(pageId).catch((err: unknown) => {
      log('tripwire_spaceOf', { pageId, failed: true, message: errorText(err) });
      return undefined;
    });
  const [sa, sb] = await Promise.all([space(pageA), space(pageB)]);
  const cache = new Map<string, Promise<Team[] | null>>();
  const teamsFor = (spaceId: string | undefined): Promise<Team[] | null> => {
    if (!spaceId) return Promise.resolve(null);
    let found = cache.get(spaceId);
    if (!found) {
      found = spaceTeamsOf(request, cloudId, spaceId);
      cache.set(spaceId, found);
    }
    return found;
  };
  const [ta, tb] = await Promise.all([teamsFor(sa), teamsFor(sb)]);
  return { teamsA: ta ? ta.map((t) => t.name) : null, teamsB: tb ? tb.map((t) => t.name) : null, sameSpace: !!sa && sa === sb };
}

/** Contributor part of `fetchPairGraph` (the original signal; best effort on sites that return null user nodes). */
async function fetchContributorGraph(request: GraphRequest, cloudId: string, pageA: string, pageB: string): Promise<PairGraph> {
  const [ca, cb] = await Promise.all([contributorsOf(request, cloudId, pageA), contributorsOf(request, cloudId, pageB)]);
  if (!ca.ok || !cb.ok) {
    const reason = (!ca.ok && ca.reason === 'error') || (!cb.ok && cb.reason === 'error') ? 'error' : 'no_data';
    return { state: 'unavailable', reason };
  }
  if (ca.ids.length === 0 || cb.ids.length === 0) {
    // Edges whose user node came back null are "the graph returned no users", not "not indexed yet".
    const empty = [ca, cb].filter((c) => c.ids.length === 0);
    return { state: 'unavailable', reason: empty.some((c) => c.nullNodes > 0) ? 'no_users' : 'not_indexed' };
  }
  const [ta, tb] = await Promise.all([teamsOf(request, ca.ids.slice(0, TEAM_LOOKUPS_PER_PAGE)), teamsOf(request, cb.ids.slice(0, TEAM_LOOKUPS_PER_PAGE))]);
  const inA = new Set(ca.ids);
  const teamIdsA = new Set(ta.teams.map((t) => t.id));
  const overlap = tb.teams.some((t) => teamIdsA.has(t.id));
  const teamsFailed = ta.failed || tb.failed;
  // "No team in common" needs every lookup to have answered and both sides to have teams.
  const sharedTeam = overlap ? true : teamsFailed || ta.teams.length === 0 || tb.teams.length === 0 ? null : false;
  const partial: PartialReason[] = [...(ca.truncated || cb.truncated ? (['contributors_truncated'] as const) : []), ...(teamsFailed ? (['teams_failed'] as const) : [])];
  return {
    state: partial.length > 0 ? 'partial' : 'ok',
    contributorsA: ca.ids.length,
    contributorsB: cb.ids.length,
    sharedContributors: cb.ids.filter((id) => inA.has(id)).length,
    teamsA: ta.teams.map((t) => t.name),
    teamsB: tb.teams.map((t) => t.name),
    sharedTeam,
    ...(partial.length > 0 ? { partial } : {}),
  };
}

/**
 * Teamwork Graph context of a decision pair, as aggregates only (account ids are used here and dropped).
 * `spaces`: teams linked to each page's space (`atlassianTeamsBySpace`), when `spaceOf` is given; shown as
 * context, never used for severity. `state` describes the contributor read: contributor counts,
 * how many they share and the teams of (up to `TEAM_LOOKUPS_PER_PAGE`) contributors. `unavailable` when the graph
 * returned no data, returned edges without users (`no_users`), has no contributors yet (`not_indexed`), or a
 * contributor query failed. `partial` when a contributor list was cut off or a team lookup failed.
 */
export async function fetchPairGraph(request: GraphRequest, cloudId: string, pageA: string, pageB: string, spaceOf?: SpaceOf): Promise<PairGraph> {
  const [contributors, spaces] = await Promise.all([
    fetchContributorGraph(request, cloudId, pageA, pageB),
    spaceOf ? fetchSpaceTeams(request, cloudId, pageA, pageB, spaceOf) : Promise.resolve(undefined),
  ]);
  return spaces ? { ...contributors, spaces } : contributors;
}

export const teamworkGraph = {
  async countRelated(anchor: string, relation: string): Promise<number> {
    throw new GraphNotImplementedError(`countRelated(${relation}) for ${anchor}`);
  },
};
