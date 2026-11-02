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
  /** Status CAS; `expect.strikes` also has to match. Bumps `version`, so a matching row always counts as changed. */
  casTripwire(id: string, fromStatuses: readonly TripwireStatus[], patch: TripwirePatch, expect?: { strikes?: number }): Promise<boolean>;
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
  /** Deletes a decision row and everything hanging off it (assumptions, tripwires, evaluations, revisits, relations). */
  deleteDecisionTree(decisionId: string): Promise<DeletedTree>;
  /**
   * Atomically takes `lock` for the page until now + `seconds` (creating a placeholder decision row if needed).
   * False when another holder's time has not run out yet.
   */
  acquirePageLock(pageId: string, lock: PageLock, nowIso: string, seconds: number): Promise<boolean>;
  releasePageLock(pageId: string, lock: PageLock): Promise<void>;
  /** Atomically takes the named app-wide lock until now + `seconds`; false while another holder's time runs. */
  acquireAppLock(name: string, nowIso: string, seconds: number): Promise<boolean>;
  releaseAppLock(name: string): Promise<void>;
  /** Small app-wide JSON values stored next to the settings (key must not be the settings key). */
  getAppValue(key: string): Promise<unknown>;
  setAppValue(key: string, value: unknown): Promise<void>;
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
function appKey(name: string): string {
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
    const affected = await execute(
      `UPDATE tripwires SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(fromStatuses.length)})${strikes !== undefined ? ' AND strikes = ?' : ''}`,
      ...values,
      id,
      ...fromStatuses,
      ...(strikes !== undefined ? [strikes] : []),
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

  async releasePageLock(pageId, lock) {
    const column = PAGE_LOCK_COLUMNS[lock];
    await execute(`UPDATE decisions SET ${column} = NULL WHERE page_id = ?`, pageId);
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
};
