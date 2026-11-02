/**
 * Contradiction Radar: finds pairs of decisions on a shared topic, asks the LLM whether they contradict, and
 * ranks open pairs with context from Teamwork Graph. Selection and ranking are pure; `runRadarScan` takes its
 * repo and classifier as dependencies.
 */
import { createHash } from 'node:crypto';
import type { DecisionRow, Repo } from '../adapters/repo';

/** `pending`: no verdict yet, only failed classifier attempts (never shown). */
export type RadarStatus = 'open' | 'dismissed' | 'resolved' | 'pending';

/**
 * Cached Teamwork Graph context of a pair: aggregates only (no account ids), so the cache can be shown to any
 * user who may view both pages. `unavailable` never means "no shared contributors": the graph had no data
 * (missing scope/header), the page is not indexed yet (no contributors), or the call failed. `partial`: the
 * contributor list was cut off after the page limit, or a team lookup failed.
 */
export type PairGraph =
  | {
      state: 'ok' | 'partial';
      contributorsA: number;
      contributorsB: number;
      sharedContributors: number;
      teamsA: string[];
      teamsB: string[];
      /** Whether the contributors' teams overlap; null when unknown. */
      sharedTeam: boolean | null;
      partial?: PartialReason[];
    }
  | { state: 'unavailable'; reason: 'no_data' | 'not_indexed' | 'error' };

export type PartialReason = 'contributors_truncated' | 'teams_failed';

export interface RadarDecisionSummary {
  id: string;
  pageId: string;
  title?: string;
  statement: string;
  team?: string;
}

export interface RadarPairRow {
  id: string;
  decisionAId: string;
  decisionBId: string;
  status: RadarStatus;
  confidence: number;
  summary: string;
  sharedTopics: string[];
  graph: PairGraph | null;
  graphFetchedAt: string | null;
  hashA: string;
  hashB: string;
  detectedAt: string;
  updatedAt: string;
}

/** A pair with the two decisions it compares. */
export interface RadarPairView {
  pair: RadarPairRow;
  a: RadarDecisionSummary;
  b: RadarDecisionSummary;
}

/** What was already assessed, keyed by the pair and the fingerprints the verdict was made on. */
export interface RadarAssessment {
  decisionAId: string;
  decisionBId: string;
  /** Fingerprints of the last verdict ('' when there is none yet). */
  hashA: string;
  hashB: string;
  /** `pairFingerprint` of the last failed attempt and how many attempts failed on it in a row. */
  failedHash?: string | null;
  attempts?: number;
}

/** One LLM verdict to store. Non-contradicting pairs are stored as `resolved` so they are not asked again. */
export interface RadarVerdictRow {
  decisionAId: string;
  decisionBId: string;
  hashA: string;
  hashB: string;
  status: 'open' | 'resolved';
  confidence: number;
  summary: string;
  sharedTopics: string[];
}

export interface RadarCandidate {
  a: DecisionRow;
  b: DecisionRow;
  sharedTopics: string[];
  hashA: string;
  hashB: string;
  /** Failed attempts on these fingerprints so far (0 for a fresh candidate). */
  attempts: number;
}

/** A classifier attempt that failed (other than a rate limit). */
export interface RadarFailureRow {
  decisionAId: string;
  decisionBId: string;
  failedHash: string;
}

// --- Topics and fingerprints --------------------------------------------------------------------------------

/** Lower case, punctuation to spaces, a trailing plural "s" dropped per word: "Data-retention policies" → "data retention policie". */
export function normaliseTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/**
 * Topics both decisions share (as written on decision `a`). Two topics match when they normalise to the same
 * words, or when every word of one appears in the other ("data retention" ~ "event data retention").
 */
export function sharedTopics(a: readonly string[], b: readonly string[]): string[] {
  const bWords = b.map((t) => normaliseTopic(t)).filter((t) => t !== '').map((t) => new Set(t.split(' ')));
  const out: string[] = [];
  for (const topic of a) {
    const norm = normaliseTopic(topic);
    if (norm === '') continue;
    const words = norm.split(' ');
    const hit = bWords.some((other) => words.every((w) => other.has(w)) || [...other].every((w) => words.includes(w)));
    if (hit && !out.includes(topic)) out.push(topic);
  }
  return out;
}

/** Fingerprint of what the LLM reads about a decision; a new page version or new wording means a new verdict. */
export function decisionHash(d: Pick<DecisionRow, 'statement' | 'title' | 'team' | 'topics' | 'pageVersion'>): string {
  const material = JSON.stringify([d.pageVersion ?? null, d.statement, d.title ?? null, d.team ?? null, [...d.topics].sort()]);
  return createHash('sha256').update(material).digest('hex');
}

const pairKey = (aId: string, bId: string): string => `${aId}\u0000${bId}`;

/** One fingerprint for both decisions, to remember which version of a pair failed. */
export function pairFingerprint(hashA: string, hashB: string): string {
  return createHash('sha256').update(`${hashA}:${hashB}`).digest('hex');
}

/** Failed attempts on the same fingerprints before a pair is skipped until one of the decisions changes. */
export const MAX_ATTEMPTS = 3;

/**
 * Decision pairs worth asking about: at least one shared topic, not already assessed on the same fingerprints,
 * and not failed `MAX_ATTEMPTS` times on them. Each pair is ordered `a.id < b.id` (the table's unique key).
 * Fresh pairs come first (most shared topics first), then retries of failed ones (fewest attempts first), so a
 * pair that keeps failing cannot take the whole per-scan budget.
 */
export function candidatePairs(decisions: readonly DecisionRow[], assessed: readonly RadarAssessment[]): RadarCandidate[] {
  const done = new Map(assessed.map((x) => [pairKey(x.decisionAId, x.decisionBId), x]));
  const usable = decisions.filter((d) => d.status === 'active' && d.statement.trim() !== '' && d.topics.length > 0 && !d.extractError);
  const sorted = [...usable].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const hashes = new Map(sorted.map((d) => [d.id, decisionHash(d)]));
  const out: RadarCandidate[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i] as DecisionRow;
      const b = sorted[j] as DecisionRow;
      if (a.pageId === b.pageId) continue;
      const shared = sharedTopics(a.topics, b.topics);
      if (shared.length === 0) continue;
      const hashA = hashes.get(a.id) as string;
      const hashB = hashes.get(b.id) as string;
      const previous = done.get(pairKey(a.id, b.id));
      if (previous && previous.hashA === hashA && previous.hashB === hashB) continue;
      const attempts = previous?.failedHash && previous.failedHash === pairFingerprint(hashA, hashB) ? (previous.attempts ?? 0) : 0;
      if (attempts >= MAX_ATTEMPTS) continue;
      out.push({ a, b, sharedTopics: shared, hashA, hashB, attempts });
    }
  }
  return out.sort((x, y) => x.attempts - y.attempts || y.sharedTopics.length - x.sharedTopics.length);
}

// --- Severity -------------------------------------------------------------------------------------------------

export type SeverityLevel = 'high' | 'medium' | 'low';

export interface Severity {
  score: number;
  level: SeverityLevel;
  /** Why the weight went up, e.g. "different teams", "no shared contributors". */
  reasons: string[];
  /** Whether Teamwork Graph context was used. */
  graph: boolean;
}

const sameTeamName = (x: string, y: string): boolean => normaliseTopic(x) === normaliseTopic(y);

/**
 * Whether the two decisions come from different teams: from Teamwork Graph teams when both pages have some
 * (no team in common), otherwise from the team names on the decisions. Undefined when unknown.
 */
export function crossTeam(teamA: string | undefined, teamB: string | undefined, graph: PairGraph | null): boolean | undefined {
  if (graph && graph.state !== 'unavailable' && graph.sharedTeam !== null) return !graph.sharedTeam;
  if (teamA && teamB) return !sameTeamName(teamA, teamB);
  return undefined;
}

/**
 * Severity = confidence × weight. Weight starts at 1; +1 when the decisions belong to different teams; +1 when
 * Teamwork Graph shows nobody contributed to both pages (the teams are not talking). Missing graph context adds
 * nothing: an unindexed page is not evidence of zero shared contributors, nor is a contributor list cut off.
 */
export function rankSeverity(
  pair: { confidence: number },
  teams: { a?: string; b?: string },
  graph: PairGraph | null,
): Severity {
  const reasons: string[] = [];
  let weight = 1;
  if (crossTeam(teams.a, teams.b, graph) === true) {
    weight += 1;
    reasons.push('different teams');
  }
  if (graph && graph.state !== 'unavailable' && graph.sharedContributors === 0 && !graph.partial?.includes('contributors_truncated')) {
    weight += 1;
    reasons.push('no shared contributors');
  }
  const confidence = Math.min(1, Math.max(0, Number.isFinite(pair.confidence) ? pair.confidence : 0));
  const score = Math.round(confidence * weight * 100) / 100;
  const level: SeverityLevel = score >= 1.5 ? 'high' : score >= 0.8 ? 'medium' : 'low';
  return { score, level, reasons, graph: !!graph && graph.state !== 'unavailable' };
}

// --- Scan --------------------------------------------------------------------------------------------------------

/** What the classifier reads about one decision. Everything except the ids comes from the page (untrusted). */
export interface RadarInput {
  title: string;
  team?: string;
  statement: string;
  topics: string[];
  assumptions: string[];
}

export interface RadarVerdict {
  contradicts: boolean;
  confidence: number;
  summary: string;
}

/** Most LLM calls one scan makes (user decision: ≤ 20 FAST_MODEL calls per scan). */
export const MAX_CLASSIFY_PER_SCAN = 20;
/** Decisions a scan considers (newest extraction first). */
export const RADAR_DECISION_LIMIT = 200;
/** Below this confidence a "contradicts" verdict is stored as resolved (not shown). */
export const MIN_CONFIDENCE = 0.5;
const ASSUMPTIONS_PER_DECISION = 8;

export interface RadarScanDeps {
  repo: Pick<Repo, 'listRadarDecisions' | 'listRadarAssessments' | 'upsertRadarPair' | 'recordRadarFailure' | 'listAssumptions'>;
  classify: (a: RadarInput, b: RadarInput) => Promise<RadarVerdict>;
  /** True when `err` means "LLM rate limited": the scan stops and keeps what it has. */
  isRateLimited: (err: unknown) => boolean;
  maxCalls?: number;
}

export interface RadarScanResult {
  candidates: number;
  classified: number;
  contradictions: number;
  errors: number;
  /** Candidates left for the next scan (cap reached or rate limited). */
  remaining: number;
  rateLimited: boolean;
}

/**
 * One scan: candidate pairs → at most `maxCalls` LLM verdicts → upsert. A pair that fails (other than a rate
 * limit) is recorded: it is retried after the fresh pairs of later scans, at most `MAX_ATTEMPTS` times on the
 * same fingerprints.
 */
export async function runRadarScan(deps: RadarScanDeps): Promise<RadarScanResult> {
  const { repo } = deps;
  const maxCalls = Math.min(deps.maxCalls ?? MAX_CLASSIFY_PER_SCAN, MAX_CLASSIFY_PER_SCAN);
  const decisions = await repo.listRadarDecisions(RADAR_DECISION_LIMIT);
  const candidates = candidatePairs(decisions, await repo.listRadarAssessments());
  const inputs = new Map<string, Promise<RadarInput>>();
  const inputFor = (d: DecisionRow): Promise<RadarInput> => {
    let found = inputs.get(d.id);
    if (!found) {
      found = repo.listAssumptions(d.id).then((assumptions) => ({
        title: d.title ?? '',
        ...(d.team ? { team: d.team } : {}),
        statement: d.statement,
        topics: d.topics,
        assumptions: assumptions.slice(0, ASSUMPTIONS_PER_DECISION).map((x) => x.summary),
      }));
      inputs.set(d.id, found);
    }
    return found;
  };

  let classified = 0;
  let contradictions = 0;
  let errors = 0;
  let rateLimited = false;
  let attempted = 0;
  for (const c of candidates) {
    if (attempted >= maxCalls) break;
    attempted += 1;
    let verdict: RadarVerdict;
    try {
      verdict = await deps.classify(await inputFor(c.a), await inputFor(c.b));
    } catch (err) {
      if (deps.isRateLimited(err)) {
        rateLimited = true;
        attempted -= 1;
        break;
      }
      errors += 1;
      console.warn('tripwire radar: classify failed', {
        decisionAId: c.a.id,
        decisionBId: c.b.id,
        attempt: c.attempts + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      await repo.recordRadarFailure({ decisionAId: c.a.id, decisionBId: c.b.id, failedHash: pairFingerprint(c.hashA, c.hashB) });
      continue;
    }
    classified += 1;
    const open = verdict.contradicts && verdict.confidence >= MIN_CONFIDENCE;
    if (open) contradictions += 1;
    await repo.upsertRadarPair({
      decisionAId: c.a.id,
      decisionBId: c.b.id,
      hashA: c.hashA,
      hashB: c.hashB,
      status: open ? 'open' : 'resolved',
      confidence: verdict.confidence,
      summary: verdict.summary,
      sharedTopics: c.sharedTopics,
    });
  }
  return { candidates: candidates.length, classified, contradictions, errors, remaining: candidates.length - attempted, rateLimited };
}
