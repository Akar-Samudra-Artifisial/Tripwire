import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, normaliseSettings, type Settings } from '../core/settings';
import type {
  Assumption,
  Decision,
  DecisionStatus,
  Evaluation,
  EvaluationOutcome,
  Relation,
  Revisit,
  RevisitOutcome,
  Tripwire,
  TripwireKind,
  TripwireStatus,
} from '../core/types';
import type { PairGraph, RadarAssessment, RadarFailureRow, RadarPairRow, RadarPairView, RadarStatus, RadarVerdictRow } from '../core/radar';
import { execute, query } from './sql';

export interface DecisionRow extends Decision {
  title?: string;
  pageVersion?: number;
  extractedAt?: string;
  extractError?: string;
}

export interface TripwireRow extends Tripwire {
  strikes: number;
  lastValue: number | null;
  lastOutcome: EvaluationOutcome | null;
  lastEvaluatedAt: string | null;
  baselineVersion: number | null;
}

export interface EvaluationRow extends Evaluation {
  detail?: string;
}

export interface RevisitRow extends Revisit {
  tripwireId?: string;
  status: 'open' | 'closed';
  createdAt: string;
}

export interface TripwireContext {
  tripwire: TripwireRow;
  assumption: Assumption;
  decision: DecisionRow;
}

export type TripwirePatch = Partial<
  Pick<
    TripwireRow,
    'status' | 'strikes' | 'lastValue' | 'lastOutcome' | 'lastEvaluatedAt' | 'kind' | 'spec' | 'confirmedBy' | 'confirmedAt' | 'baselineVersion'
  >
>;

export interface RevisitClose {
  outcome: RevisitOutcome;
  resolvedBy: string;
  newThreshold?: number;
  supersededByDecisionId?: string;
}

/** One tripwire with its assumption, decision and open Revisit issue (for the Rovo `list-tripped` action). */
export interface WatchRow {
  tripwire: TripwireRow;
  assumption: Assumption;
  decision: Pick<DecisionRow, 'id' | 'pageId' | 'statement' | 'title' | 'team' | 'ownerAccountId'>;
  revisitIssueKey?: string;
}

/** Rows removed by `deleteDecisionTree`. */
export interface DeletedTree {
  tripwires: number;
  assumptions: number;
  evaluations: number;
  revisits: number;
}

/** Per-page timestamps on `decisions`: a scan cooldown and two short-lived locks (see `acquirePageLock`). */
export type PageLock = 'scan' | 'extract' | 'revisit';

/** Extra conditions of `casTripwire`. */
export interface TripwireExpect {
  strikes?: number;
  /** `null` matches a tripwire without a baseline. */
  baselineVersion?: number | null;
}

const PAGE_LOCK_COLUMNS: Record<PageLock, string> = {
  scan: 'scan_cooldown_until',
  extract: 'extract_lock_until',
  revisit: 'revisit_lock_until',
};

/** Every SQL read/write the app makes. `sqlRepo` is the Forge SQL implementation; tests use `test/helpers/fakeRepo.ts`. */
export interface Repo {
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  getDecisionByPage(pageId: string): Promise<DecisionRow | undefined>;
  getDecision(id: string): Promise<DecisionRow | undefined>;
  upsertDecision(d: Omit<DecisionRow, 'id'> & { id?: string }): Promise<DecisionRow>;
  markExtractError(pageId: string, error: string): Promise<void>;
  listAssumptions(decisionId: string): Promise<Assumption[]>;
  listTripwires(decisionId: string): Promise<TripwireRow[]>;
  hasConfirmedTripwires(decisionId: string): Promise<boolean>;
  replaceProposed(decisionId: string, items: { assumption: Assumption; tripwire: TripwireRow }[]): Promise<void>;
  getTripwireContext(id: string): Promise<TripwireContext | undefined>;
  listTripwireIdsForEvaluation(statuses: readonly TripwireStatus[], limit: number, offset: number): Promise<string[]>;
  /**
   * Status CAS; `expect.strikes` / `expect.baselineVersion` (null matches NULL) also have to match. Bumps `version`,
   * so a matching row always counts as changed.
   */
  casTripwire(id: string, fromStatuses: readonly TripwireStatus[], patch: TripwirePatch, expect?: TripwireExpect): Promise<boolean>;
  insertEvaluation(e: EvaluationRow): Promise<void>;
  listEvaluations(tripwireId: string, limit: number): Promise<EvaluationRow[]>;
  findOpenRevisit(decisionId: string): Promise<RevisitRow | undefined>;
  getRevisitByIssue(issueKey: string): Promise<RevisitRow | undefined>;
  insertRevisit(r: Omit<RevisitRow, 'createdAt'>): Promise<void>;
  /** Closes an open revisit; false when it was not open any more (someone else closed it first). */
  closeRevisit(id: string, patch: RevisitClose): Promise<boolean>;
  insertRelation(r: Omit<Relation, 'id' | 'createdAt'>): Promise<void>;
  /**
   * Tripwires in `statuses`, most recently evaluated first, with their decision and open Revisit issue.
   * `team` (case-insensitive) is applied before `limit`.
   */
  listWatchRows(statuses: readonly TripwireStatus[], limit: number, team?: string): Promise<WatchRow[]>;
  /** Deletes a decision row and everything hanging off it (assumptions, tripwires, evaluations, revisits, relations, radar pairs). */
  deleteDecisionTree(decisionId: string): Promise<DeletedTree>;
  /**
   * Atomically takes `lock` for the page until now + `seconds` (creating a placeholder decision row if needed).
   * False when another holder's time has not run out yet.
   */
  acquirePageLock(pageId: string, lock: PageLock, nowIso: string, seconds: number): Promise<boolean>;
  /** Frees the lock; with `heldUntil` (the end time this holder set) only while it is still that holder's lock. */
  releasePageLock(pageId: string, lock: PageLock, heldUntil?: string): Promise<void>;
  /** Atomically takes the named app-wide lock until now + `seconds`; false while another holder's time runs. */
  acquireAppLock(name: string, nowIso: string, seconds: number): Promise<boolean>;
  releaseAppLock(name: string): Promise<void>;
  /** Small app-wide JSON values stored next to the settings (key must not be the settings key). */
  getAppValue(key: string): Promise<unknown>;
  setAppValue(key: string, value: unknown): Promise<void>;
  /** Tripwire count per status (Decision Health overview). */
  countTripwiresByStatus(): Promise<Partial<Record<TripwireStatus, number>>>;
  /** Extracted, active decisions with a statement, newest extraction first (Radar candidates). */
  listRadarDecisions(limit: number): Promise<DecisionRow[]>;
  /** Pairs already assessed (or failed), with the fingerprints their verdict was made on and failure counts. */
  listRadarAssessments(): Promise<RadarAssessment[]>;
  /**
   * Inserts or updates the pair's verdict (unique on decision_a_id, decision_b_id) and clears its failure count.
   * A `dismissed` pair stays dismissed only while both fingerprints are unchanged; its graph cache is kept.
   */
  upsertRadarPair(p: RadarVerdictRow): Promise<void>;
  /**
   * Counts one failed classifier attempt: `attempts` + 1 when `failedHash` is the same as last time, else 1. A
   * pair without a verdict is stored as `pending` (never listed).
   */
  recordRadarFailure(p: RadarFailureRow): Promise<void>;
  /** Pairs in `statuses` with both decisions, most confident first. */
  listRadarPairs(statuses: readonly RadarStatus[], limit: number): Promise<RadarPairView[]>;
  getRadarPair(id: string): Promise<RadarPairView | undefined>;
  /**
   * Stores the graph cache. With `keepOkSince`, a non-`ok` graph does not replace an `ok` one fetched after that
   * time (still fresh); returns false when nothing was written.
   */
  updateRadarPairGraph(id: string, graph: PairGraph, fetchedAt: string, keepOkSince?: string): Promise<boolean>;
  /** Clears graph caches written before they held aggregates only (they contained contributor account ids). */
  purgeLegacyRadarGraphs(): Promise<number>;
  /** Clears the non-`ok` graph caches of the decision's pairs (fetched again on the next view); returns how many. */
  clearRadarGraphCache(decisionId: string): Promise<number>;
  /** Sets the extracted page version from `from` to `to`; false when it was not `from` (or no decision). */
  setDecisionPageVersion(pageId: string, from: number, to: number): Promise<boolean>;
  /** Status CAS; false when the pair is missing or not in `from`. */
  setRadarPairStatus(id: string, from: readonly RadarStatus[], to: RadarStatus): Promise<boolean>;
}

// --- Column helpers -------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Forge SQL may return JSON columns as a string or as an already-parsed value. */
export function parseJsonColumn<T>(raw: unknown): T {
  if (typeof raw === 'string') return JSON.parse(raw) as T;
  return raw as T;
}

/** ISO timestamp → MySQL `YYYY-MM-DD HH:MM:SS` (UTC). */
export function toSqlTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${iso}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** MySQL TIMESTAMP (string or Date, UTC) → ISO string; null/undefined stay null. */
export function fromSqlTs(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString();
  const text = String(raw);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}

function toSqlDate(value: string | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function fromSqlDate(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}

const str = (raw: unknown): string | undefined => (raw === null || raw === undefined ? undefined : String(raw));
const num = (raw: unknown): number | null => (raw === null || raw === undefined ? null : Number(raw));
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Integer for inline `LIMIT`/`OFFSET`: Forge SQL (TiDB) rejects bound LIMIT parameters with `ER_WRONG_ARGUMENTS`.
 * Truncates and clamps to [min, max]; throws on non-finite input so only a number ever reaches the SQL text.
 */
export function sqlInt(n: number, min: number, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`sqlInt: expected a finite number, got ${String(n)}`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const DECISION_COLS =
  'id, page_id, statement, owner_account_id, team, decided_at, topics, status, title, page_version, extracted_at, extract_error';
const TRIPWIRE_COLS =
  't.id, t.assumption_id, t.kind, t.spec, t.status, t.confirmed_by, t.confirmed_at, t.strikes, t.`last_value`, t.last_outcome, t.last_evaluated_at, t.baseline_version';
const EVALUATION_COLS = 'id, tripwire_id, value, outcome, evaluated_at, detail';
const REVISIT_COLS =
  'id, decision_id, issue_key, outcome, new_threshold, superseded_by_decision_id, created_at, tripwire_id, status';

function toDecision(r: Row): DecisionRow {
  return {
    id: String(r.id),
    pageId: String(r.page_id),
    statement: String(r.statement ?? ''),
    ownerAccountId: str(r.owner_account_id),
    team: str(r.team),
    decidedAt: fromSqlDate(r.decided_at),
    topics: parseJsonColumn<string[] | null>(r.topics) ?? [],
    status: String(r.status) as DecisionStatus,
    title: str(r.title),
    pageVersion: num(r.page_version) ?? undefined,
    extractedAt: fromSqlTs(r.extracted_at) ?? undefined,
    extractError: str(r.extract_error),
  };
}

function toAssumption(r: Row): Assumption {
  return { id: String(r.id), decisionId: String(r.decision_id), quote: String(r.quote), summary: String(r.summary) };
}

function toTripwire(r: Row): TripwireRow {
  return {
    id: String(r.id),
    assumptionId: String(r.assumption_id),
    kind: String(r.kind) as TripwireKind,
    spec: parseJsonColumn<Tripwire['spec']>(r.spec),
    status: String(r.status) as TripwireStatus,
    confirmedBy: str(r.confirmed_by),
    confirmedAt: fromSqlTs(r.confirmed_at) ?? undefined,
    strikes: Number(r.strikes ?? 0),
    lastValue: num(r.last_value),
    lastOutcome: (str(r.last_outcome) as EvaluationOutcome | undefined) ?? null,
    lastEvaluatedAt: fromSqlTs(r.last_evaluated_at),
    baselineVersion: num(r.baseline_version),
  };
}

function toEvaluation(r: Row): EvaluationRow {
  return {
    id: String(r.id),
    tripwireId: String(r.tripwire_id),
    value: num(r.value),
    outcome: String(r.outcome) as EvaluationOutcome,
    evaluatedAt: fromSqlTs(r.evaluated_at) ?? '',
    detail: str(r.detail),
  };
}

function toRevisit(r: Row): RevisitRow {
  return {
    id: String(r.id),
    decisionId: String(r.decision_id),
    issueKey: String(r.issue_key),
    outcome: str(r.outcome) as RevisitOutcome | undefined,
    newThreshold: num(r.new_threshold) ?? undefined,
    supersededByDecisionId: str(r.superseded_by_decision_id),
    createdAt: fromSqlTs(r.created_at) ?? '',
    tripwireId: str(r.tripwire_id),
    status: r.status === 'closed' ? 'closed' : 'open',
  };
}

const RADAR_STATUSES: readonly RadarStatus[] = ['open', 'dismissed', 'resolved', 'pending'];

const RADAR_PAIR_COLS =
  'p.id, p.decision_a_id, p.decision_b_id, p.status, p.confidence, p.summary, p.shared_topics, p.graph_json, p.graph_fetched_at, p.hash_a, p.hash_b, p.detected_at, p.updated_at, ' +
  'da.page_id AS a_page_id, da.title AS a_title, da.statement AS a_statement, da.team AS a_team, ' +
  'db.page_id AS b_page_id, db.title AS b_title, db.statement AS b_statement, db.team AS b_team';
const RADAR_PAIR_FROM = 'radar_pairs p JOIN decisions da ON da.id = p.decision_a_id JOIN decisions db ON db.id = p.decision_b_id';

/**
 * Malformed or legacy cached graph JSON (the old shape held contributor account ids) is treated as "not fetched"
 * so the next view fetches it again.
 */
export function parseGraph(raw: unknown): PairGraph | null {
  if (raw === null || raw === undefined) return null;
  try {
    const g = parseJsonColumn<Record<string, unknown> | null>(raw);
    if (!g) return null;
    if (g.state === 'unavailable' && typeof g.reason === 'string') return g as PairGraph;
    if ((g.state === 'ok' || g.state === 'partial') && typeof g.contributorsA === 'number' && Array.isArray(g.teamsA)) return g as PairGraph;
    return null;
  } catch {
    return null;
  }
}

function toRadarPairView(r: Row): RadarPairView {
  const status = String(r.status) as RadarStatus;
  const pair: RadarPairRow = {
    id: String(r.id),
    decisionAId: String(r.decision_a_id),
    decisionBId: String(r.decision_b_id),
    status: RADAR_STATUSES.includes(status) ? status : 'resolved',
    confidence: Number(r.confidence ?? 0),
    summary: String(r.summary ?? ''),
    sharedTopics: parseJsonColumn<string[] | null>(r.shared_topics) ?? [],
    graph: parseGraph(r.graph_json),
    graphFetchedAt: fromSqlTs(r.graph_fetched_at),
    hashA: String(r.hash_a),
    hashB: String(r.hash_b),
    detectedAt: fromSqlTs(r.detected_at) ?? '',
    updatedAt: fromSqlTs(r.updated_at) ?? '',
  };
  return {
    pair,
    a: { id: pair.decisionAId, pageId: String(r.a_page_id), title: str(r.a_title), statement: String(r.a_statement ?? ''), team: str(r.a_team) },
    b: { id: pair.decisionBId, pageId: String(r.b_page_id), title: str(r.b_title), statement: String(r.b_statement ?? ''), team: str(r.b_team) },
  };
}

/** TripwirePatch field → [column, value encoder]. Keeps `casTripwire` free of string-built values. */
const PATCH_COLUMNS: { [K in keyof Required<TripwirePatch>]: [string, (v: TripwirePatch[K]) => unknown] } = {
  status: ['status', (v) => v],
  strikes: ['strikes', (v) => v],
  lastValue: ['`last_value`', (v) => v ?? null],
  lastOutcome: ['last_outcome', (v) => v ?? null],
  lastEvaluatedAt: ['last_evaluated_at', (v) => (v ? toSqlTs(v) : null)],
  kind: ['kind', (v) => v],
  spec: ['spec', (v) => JSON.stringify(v)],
  confirmedBy: ['confirmed_by', (v) => v ?? null],
  confirmedAt: ['confirmed_at', (v) => (v ? toSqlTs(v) : null)],
  baselineVersion: ['baseline_version', (v) => v ?? null],
};

async function insertAssumption(a: Assumption): Promise<void> {
  await execute('INSERT INTO assumptions (id, decision_id, quote, summary) VALUES (?, ?, ?, ?)', a.id, a.decisionId, a.quote, a.summary);
}

async function insertTripwire(t: TripwireRow): Promise<void> {
  await execute(
    `INSERT INTO tripwires (id, assumption_id, kind, spec, status, confirmed_by, confirmed_at, strikes, \`last_value\`, last_outcome, last_evaluated_at, baseline_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.id,
    t.assumptionId,
    t.kind,
    JSON.stringify(t.spec),
    t.status,
    t.confirmedBy ?? null,
    t.confirmedAt ? toSqlTs(t.confirmedAt) : null,
    t.strikes,
    t.lastValue,
    t.lastOutcome,
    t.lastEvaluatedAt ? toSqlTs(t.lastEvaluatedAt) : null,
    t.baselineVersion,
  );
}

const SETTINGS_KEY = 'app';

/** Validates an app lock/value name (fixed identifiers only; never user input). */
export function appKey(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || name === SETTINGS_KEY) throw new Error(`Invalid app key: ${name}`);
  return name;
}

export const sqlRepo: Repo = {
  async getSettings() {
    const rows = await query<Row>('SELECT v FROM settings WHERE k = ?', SETTINGS_KEY);
    const first = rows[0];
    if (!first) return { ...DEFAULT_SETTINGS, watchedSpaceKeys: [], allowedProjectKeys: [] };
    return normaliseSettings(parseJsonColumn<unknown>(first.v));
  },

  async saveSettings(s) {
    await execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', SETTINGS_KEY, JSON.stringify(s));
  },

  async getDecisionByPage(pageId) {
    const rows = await query<Row>(`SELECT ${DECISION_COLS} FROM decisions WHERE page_id = ?`, pageId);
    return rows[0] ? toDecision(rows[0]) : undefined;
  },

  async getDecision(id) {
    const rows = await query<Row>(`SELECT ${DECISION_COLS} FROM decisions WHERE id = ?`, id);
    return rows[0] ? toDecision(rows[0]) : undefined;
  },

  async upsertDecision(d) {
    await execute(
      `INSERT INTO decisions (id, page_id, statement, owner_account_id, team, decided_at, topics, status, title, page_version, extracted_at, extract_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE statement = VALUES(statement), title = VALUES(title), owner_account_id = VALUES(owner_account_id),
         team = VALUES(team), decided_at = VALUES(decided_at), topics = VALUES(topics), page_version = VALUES(page_version),
         extracted_at = VALUES(extracted_at), extract_error = VALUES(extract_error)`,
      d.id ?? randomUUID(),
      d.pageId,
      d.statement,
      d.ownerAccountId ?? null,
      d.team ?? null,
      toSqlDate(d.decidedAt),
      JSON.stringify(d.topics),
      d.status,
      d.title ?? null,
      d.pageVersion ?? null,
      d.extractedAt ? toSqlTs(d.extractedAt) : null,
      d.extractError ?? null,
    );
    const saved = await this.getDecisionByPage(d.pageId);
    if (!saved) throw new Error(`Decision for page ${d.pageId} was not saved`);
    return saved;
  },

  async markExtractError(pageId, error) {
    await execute(
      `INSERT INTO decisions (id, page_id, statement, extract_error) VALUES (?, ?, '', ?)
       ON DUPLICATE KEY UPDATE extract_error = VALUES(extract_error)`,
      randomUUID(),
      pageId,
      error,
    );
  },

  async listAssumptions(decisionId) {
    const rows = await query<Row>('SELECT id, decision_id, quote, summary FROM assumptions WHERE decision_id = ? ORDER BY created_at, id', decisionId);
    return rows.map(toAssumption);
  },

  async listTripwires(decisionId) {
    const rows = await query<Row>(
      `SELECT ${TRIPWIRE_COLS} FROM tripwires t JOIN assumptions a ON a.id = t.assumption_id WHERE a.decision_id = ? ORDER BY t.created_at, t.id`,
      decisionId,
    );
    return rows.map(toTripwire);
  },

  async hasConfirmedTripwires(decisionId) {
    const rows = await query<Row>(
      `SELECT t.id FROM tripwires t JOIN assumptions a ON a.id = t.assumption_id WHERE a.decision_id = ? AND t.status <> 'proposed' LIMIT 1`,
      decisionId,
    );
    return rows.length > 0;
  },

  async replaceProposed(decisionId, items) {
    const proposed = await query<Row>(
      `SELECT t.id FROM tripwires t JOIN assumptions a ON a.id = t.assumption_id WHERE a.decision_id = ? AND t.status = 'proposed'`,
      decisionId,
    );
    const ids = proposed.map((r) => String(r.id));
    if (ids.length > 0) await execute(`DELETE FROM tripwires WHERE id IN (${placeholders(ids.length)})`, ...ids);
    const orphans = await query<Row>(
      'SELECT a.id FROM assumptions a WHERE a.decision_id = ? AND NOT EXISTS (SELECT 1 FROM tripwires t WHERE t.assumption_id = a.id)',
      decisionId,
    );
    const orphanIds = orphans.map((r) => String(r.id));
    if (orphanIds.length > 0) {
      // Relations first: if the assumption delete fails, a retry still finds the orphans and cleans both.
      await execute(
        `DELETE FROM relations WHERE type = 'rests-on' AND from_id = ? AND to_id IN (${placeholders(orphanIds.length)})`,
        decisionId,
        ...orphanIds,
      );
      await execute(`DELETE FROM assumptions WHERE id IN (${placeholders(orphanIds.length)})`, ...orphanIds);
    }
    for (const item of items) {
      await insertAssumption({ ...item.assumption, decisionId });
      await insertTripwire(item.tripwire);
    }
  },

  async getTripwireContext(id) {
    const rows = await query<Row>(
      `SELECT ${TRIPWIRE_COLS}, a.decision_id AS a_decision_id, a.quote AS a_quote, a.summary AS a_summary
       FROM tripwires t JOIN assumptions a ON a.id = t.assumption_id WHERE t.id = ?`,
      id,
    );
    const row = rows[0];
    if (!row) return undefined;
    const tripwire = toTripwire(row);
    const assumption = toAssumption({ id: row.assumption_id, decision_id: row.a_decision_id, quote: row.a_quote, summary: row.a_summary });
    const decision = await this.getDecision(assumption.decisionId);
    return decision ? { tripwire, assumption, decision } : undefined;
  },

  async listTripwireIdsForEvaluation(statuses, limit, offset) {
    if (statuses.length === 0) return [];
    const rows = await query<Row>(
      `SELECT id FROM tripwires WHERE status IN (${placeholders(statuses.length)}) ORDER BY id LIMIT ${sqlInt(limit, 0, 10_000)} OFFSET ${sqlInt(offset, 0, 1_000_000)}`,
      ...statuses,
    );
    return rows.map((r) => String(r.id));
  },

  async casTripwire(id, fromStatuses, patch, expect) {
    const entries = (Object.keys(patch) as (keyof TripwirePatch)[]).filter((k) => patch[k] !== undefined);
    if (entries.length === 0 || fromStatuses.length === 0) return false;
    // version always changes: MySQL counts only changed rows, and second-precision timestamps can repeat.
    const sets = [...entries.map((k) => `${PATCH_COLUMNS[k][0]} = ?`), '`version` = `version` + 1'];
    const values = entries.map((k) => (PATCH_COLUMNS[k][1] as (v: unknown) => unknown)(patch[k]));
    const strikes = expect?.strikes;
    const baseline = expect?.baselineVersion;
    const affected = await execute(
      `UPDATE tripwires SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(fromStatuses.length)})` +
        `${strikes !== undefined ? ' AND strikes = ?' : ''}${baseline !== undefined ? ' AND baseline_version <=> ?' : ''}`,
      ...values,
      id,
      ...fromStatuses,
      ...(strikes !== undefined ? [strikes] : []),
      ...(baseline !== undefined ? [baseline] : []),
    );
    return affected === 1;
  },

  async insertEvaluation(e) {
    await execute(
      'INSERT INTO evaluations (id, tripwire_id, value, outcome, evaluated_at, detail) VALUES (?, ?, ?, ?, ?, ?)',
      e.id,
      e.tripwireId,
      e.value,
      e.outcome,
      toSqlTs(e.evaluatedAt),
      e.detail ?? null,
    );
  },

  async listEvaluations(tripwireId, limit) {
    const rows = await query<Row>(
      `SELECT ${EVALUATION_COLS} FROM evaluations WHERE tripwire_id = ? ORDER BY evaluated_at DESC, id DESC LIMIT ${sqlInt(limit, 0, 1_000)}`,
      tripwireId,
    );
    return rows.map(toEvaluation);
  },

  async findOpenRevisit(decisionId) {
    const rows = await query<Row>(
      `SELECT ${REVISIT_COLS} FROM revisits WHERE decision_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      decisionId,
    );
    return rows[0] ? toRevisit(rows[0]) : undefined;
  },

  async getRevisitByIssue(issueKey) {
    const rows = await query<Row>(`SELECT ${REVISIT_COLS} FROM revisits WHERE issue_key = ?`, issueKey);
    return rows[0] ? toRevisit(rows[0]) : undefined;
  },

  async insertRevisit(r) {
    await execute(
      `INSERT INTO revisits (id, decision_id, issue_key, outcome, new_threshold, superseded_by_decision_id, tripwire_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.decisionId,
      r.issueKey,
      r.outcome ?? null,
      r.newThreshold ?? null,
      r.supersededByDecisionId ?? null,
      r.tripwireId ?? null,
      r.status,
    );
  },

  async closeRevisit(id, patch) {
    const affected = await execute(
      `UPDATE revisits SET status = 'closed', outcome = ?, resolved_by = ?, resolved_at = ?, new_threshold = ?, superseded_by_decision_id = ?
       WHERE id = ? AND status = 'open'`,
      patch.outcome,
      patch.resolvedBy,
      toSqlTs(new Date().toISOString()),
      patch.newThreshold ?? null,
      patch.supersededByDecisionId ?? null,
      id,
    );
    return affected === 1;
  },

  async insertRelation(r) {
    await execute('INSERT INTO relations (id, type, from_id, to_id) VALUES (?, ?, ?, ?)', randomUUID(), r.type, r.fromId, r.toId);
  },

  async listWatchRows(statuses, limit, team) {
    if (statuses.length === 0) return [];
    const teamFilter = team ? ' AND LOWER(d.team) = ?' : '';
    const rows = await query<Row>(
      `SELECT ${TRIPWIRE_COLS}, a.decision_id AS a_decision_id, a.quote AS a_quote, a.summary AS a_summary,
         d.page_id AS d_page_id, d.statement AS d_statement, d.title AS d_title, d.team AS d_team, d.owner_account_id AS d_owner,
         r.issue_key AS r_issue_key
       FROM tripwires t
       JOIN assumptions a ON a.id = t.assumption_id
       JOIN decisions d ON d.id = a.decision_id
       LEFT JOIN revisits r ON r.decision_id = d.id AND r.status = 'open'
       WHERE t.status IN (${placeholders(statuses.length)})${teamFilter}
       ORDER BY t.last_evaluated_at DESC, t.id LIMIT ${sqlInt(limit, 0, 500)}`,
      ...statuses,
      ...(team ? [team.toLowerCase()] : []),
    );
    const seen = new Set<string>();
    const out: WatchRow[] = [];
    for (const row of rows) {
      const tripwire = toTripwire(row);
      // Two open revisits for one decision should not exist; never list a tripwire twice if they do.
      if (seen.has(tripwire.id)) continue;
      seen.add(tripwire.id);
      out.push({
        tripwire,
        assumption: toAssumption({ id: row.assumption_id, decision_id: row.a_decision_id, quote: row.a_quote, summary: row.a_summary }),
        decision: {
          id: String(row.a_decision_id),
          pageId: String(row.d_page_id),
          statement: String(row.d_statement ?? ''),
          title: str(row.d_title),
          team: str(row.d_team),
          ownerAccountId: str(row.d_owner),
        },
        ...(row.r_issue_key ? { revisitIssueKey: String(row.r_issue_key) } : {}),
      });
    }
    return out;
  },

  async deleteDecisionTree(decisionId) {
    const assumptionIds = (await query<Row>('SELECT id FROM assumptions WHERE decision_id = ?', decisionId)).map((r) => String(r.id));
    const tripwireIds =
      assumptionIds.length > 0
        ? (await query<Row>(`SELECT id FROM tripwires WHERE assumption_id IN (${placeholders(assumptionIds.length)})`, ...assumptionIds)).map((r) =>
            String(r.id),
          )
        : [];
    const revisitKeys = (await query<Row>('SELECT issue_key FROM revisits WHERE decision_id = ?', decisionId)).map((r) => String(r.issue_key));
    // Children first, the decision row last: a failed run can be repeated and still finds everything by decision id.
    const evaluations =
      tripwireIds.length > 0 ? await execute(`DELETE FROM evaluations WHERE tripwire_id IN (${placeholders(tripwireIds.length)})`, ...tripwireIds) : 0;
    const relationIds = [decisionId, ...assumptionIds, ...revisitKeys];
    await execute(
      `DELETE FROM relations WHERE from_id IN (${placeholders(relationIds.length)}) OR to_id IN (${placeholders(relationIds.length)})`,
      ...relationIds,
      ...relationIds,
    );
    const tripwires =
      tripwireIds.length > 0 ? await execute(`DELETE FROM tripwires WHERE id IN (${placeholders(tripwireIds.length)})`, ...tripwireIds) : 0;
    const revisits = await execute('DELETE FROM revisits WHERE decision_id = ?', decisionId);
    await execute('DELETE FROM radar_pairs WHERE decision_a_id = ? OR decision_b_id = ?', decisionId, decisionId);
    const assumptions = await execute('DELETE FROM assumptions WHERE decision_id = ?', decisionId);
    await execute('DELETE FROM decisions WHERE id = ?', decisionId);
    return { tripwires, assumptions, evaluations, revisits };
  },

  async acquirePageLock(pageId, lock, nowIso, seconds) {
    const column = PAGE_LOCK_COLUMNS[lock];
    await execute(
      `INSERT INTO decisions (id, page_id, statement) VALUES (?, ?, '') ON DUPLICATE KEY UPDATE page_id = page_id`,
      randomUUID(),
      pageId,
    );
    const now = toSqlTs(nowIso);
    const until = toSqlTs(new Date(new Date(nowIso).getTime() + seconds * 1000).toISOString());
    const affected = await execute(
      `UPDATE decisions SET ${column} = ? WHERE page_id = ? AND (${column} IS NULL OR ${column} <= ?)`,
      until,
      pageId,
      now,
    );
    return affected === 1;
  },

  async releasePageLock(pageId, lock, heldUntil) {
    const column = PAGE_LOCK_COLUMNS[lock];
    if (heldUntil === undefined) {
      await execute(`UPDATE decisions SET ${column} = NULL WHERE page_id = ?`, pageId);
      return;
    }
    await execute(`UPDATE decisions SET ${column} = NULL WHERE page_id = ? AND ${column} = ?`, pageId, toSqlTs(heldUntil));
  },

  async acquireAppLock(name, nowIso, seconds) {
    await execute('INSERT INTO app_locks (name, until_at) VALUES (?, NULL) ON DUPLICATE KEY UPDATE name = name', appKey(name));
    const until = toSqlTs(new Date(new Date(nowIso).getTime() + seconds * 1000).toISOString());
    const affected = await execute(
      'UPDATE app_locks SET until_at = ? WHERE name = ? AND (until_at IS NULL OR until_at <= ?)',
      until,
      appKey(name),
      toSqlTs(nowIso),
    );
    return affected === 1;
  },

  async releaseAppLock(name) {
    await execute('UPDATE app_locks SET until_at = NULL WHERE name = ?', appKey(name));
  },

  async getAppValue(key) {
    const rows = await query<Row>('SELECT v FROM settings WHERE k = ?', appKey(key));
    return rows[0] ? parseJsonColumn<unknown>(rows[0].v) : undefined;
  },

  async setAppValue(key, value) {
    await execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', appKey(key), JSON.stringify(value));
  },

  async countTripwiresByStatus() {
    const rows = await query<Row>('SELECT status, COUNT(*) AS n FROM tripwires GROUP BY status');
    return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n ?? 0)])) as Partial<Record<TripwireStatus, number>>;
  },

  async listRadarDecisions(limit) {
    const rows = await query<Row>(
      `SELECT ${DECISION_COLS} FROM decisions
       WHERE status = 'active' AND extracted_at IS NOT NULL AND extract_error IS NULL AND statement <> ''
       ORDER BY extracted_at DESC, id LIMIT ${sqlInt(limit, 0, 1_000)}`,
    );
    return rows.map(toDecision);
  },

  async listRadarAssessments() {
    const rows = await query<Row>('SELECT decision_a_id, decision_b_id, hash_a, hash_b, failed_hash, attempts FROM radar_pairs LIMIT 20000');
    return rows.map((r) => ({
      decisionAId: String(r.decision_a_id),
      decisionBId: String(r.decision_b_id),
      hashA: String(r.hash_a),
      hashB: String(r.hash_b),
      failedHash: str(r.failed_hash) ?? null,
      attempts: Number(r.attempts ?? 0),
    }));
  },

  async upsertRadarPair(p) {
    if (!(p.decisionAId < p.decisionBId)) throw new Error('radar pair must be ordered decision_a_id < decision_b_id');
    await execute(
      `INSERT INTO radar_pairs (id, decision_a_id, decision_b_id, status, confidence, summary, shared_topics, hash_a, hash_b)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = IF(status = 'dismissed' AND hash_a = VALUES(hash_a) AND hash_b = VALUES(hash_b), 'dismissed', VALUES(status)),
         confidence = VALUES(confidence), summary = VALUES(summary), shared_topics = VALUES(shared_topics),
         hash_a = VALUES(hash_a), hash_b = VALUES(hash_b), failed_hash = NULL, attempts = 0`,
      randomUUID(),
      p.decisionAId,
      p.decisionBId,
      p.status,
      p.confidence,
      p.summary,
      JSON.stringify(p.sharedTopics),
      p.hashA,
      p.hashB,
    );
  },

  async recordRadarFailure(p) {
    if (!(p.decisionAId < p.decisionBId)) throw new Error('radar pair must be ordered decision_a_id < decision_b_id');
    await execute(
      `INSERT INTO radar_pairs (id, decision_a_id, decision_b_id, status, hash_a, hash_b, failed_hash, attempts)
       VALUES (?, ?, ?, 'pending', '', '', ?, 1)
       ON DUPLICATE KEY UPDATE attempts = IF(failed_hash = VALUES(failed_hash), attempts + 1, 1), failed_hash = VALUES(failed_hash)`,
      randomUUID(),
      p.decisionAId,
      p.decisionBId,
      p.failedHash,
    );
  },

  async listRadarPairs(statuses, limit) {
    if (statuses.length === 0) return [];
    const rows = await query<Row>(
      `SELECT ${RADAR_PAIR_COLS} FROM ${RADAR_PAIR_FROM} WHERE p.status IN (${placeholders(statuses.length)})
       ORDER BY p.confidence DESC, p.id LIMIT ${sqlInt(limit, 0, 500)}`,
      ...statuses,
    );
    return rows.map(toRadarPairView);
  },

  async getRadarPair(id) {
    const rows = await query<Row>(`SELECT ${RADAR_PAIR_COLS} FROM ${RADAR_PAIR_FROM} WHERE p.id = ?`, id);
    return rows[0] ? toRadarPairView(rows[0]) : undefined;
  },

  async updateRadarPairGraph(id, graph, fetchedAt, keepOkSince) {
    if (graph.state !== 'ok' && keepOkSince) {
      const affected = await execute(
        `UPDATE radar_pairs SET graph_json = ?, graph_fetched_at = ? WHERE id = ?
         AND NOT (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(graph_json, '$.state')), '') = 'ok' AND graph_fetched_at IS NOT NULL AND graph_fetched_at > ?)`,
        JSON.stringify(graph),
        toSqlTs(fetchedAt),
        id,
        toSqlTs(keepOkSince),
      );
      return affected === 1;
    }
    return (await execute('UPDATE radar_pairs SET graph_json = ?, graph_fetched_at = ? WHERE id = ?', JSON.stringify(graph), toSqlTs(fetchedAt), id)) === 1;
  },

  async purgeLegacyRadarGraphs() {
    return execute(`UPDATE radar_pairs SET graph_json = NULL, graph_fetched_at = NULL WHERE JSON_EXTRACT(graph_json, '$.a') IS NOT NULL`);
  },

  async clearRadarGraphCache(decisionId) {
    return execute(
      `UPDATE radar_pairs SET graph_json = NULL, graph_fetched_at = NULL
       WHERE (decision_a_id = ? OR decision_b_id = ?) AND graph_json IS NOT NULL
       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(graph_json, '$.state')), '') <> 'ok'`,
      decisionId,
      decisionId,
    );
  },

  async setDecisionPageVersion(pageId, from, to) {
    return (await execute('UPDATE decisions SET page_version = ? WHERE page_id = ? AND page_version = ?', to, pageId, from)) === 1;
  },

  async setRadarPairStatus(id, from, to) {
    if (from.length === 0) return false;
    const affected = await execute(`UPDATE radar_pairs SET status = ? WHERE id = ? AND status IN (${placeholders(from.length)})`, to, id, ...from);
    return affected === 1;
  },
};
