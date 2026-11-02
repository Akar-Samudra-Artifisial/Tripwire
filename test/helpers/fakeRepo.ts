import { randomUUID } from 'node:crypto';
import type { DecisionRow, EvaluationRow, PageLock, Repo, RevisitRow, TripwireRow } from '../../src/adapters/repo';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import type { RadarPairRow, RadarPairView } from '../../src/core/radar';
import type { Assumption, Relation, TripwireStatus } from '../../src/core/types';

/** In-memory `Repo` with the same semantics as `sqlRepo` (unique page per decision, CAS on status). */
export interface FakeRepo extends Repo {
  settings: Settings;
  decisions: Map<string, DecisionRow>;
  assumptions: Map<string, Assumption>;
  tripwires: Map<string, TripwireRow>;
  evaluations: EvaluationRow[];
  revisits: Map<string, RevisitRow & { resolvedBy?: string; resolvedAt?: string }>;
  relations: Relation[];
  /** pageId → lock → ISO time the lock/cooldown ends. */
  pageLocks: Map<string, Partial<Record<PageLock, string>>>;
  /** Bumped by every successful `casTripwire`, like the SQL `version` column. */
  versions: Map<string, number>;
  /** App lock name → ISO time the lock ends. */
  appLocks: Map<string, string>;
  appValues: Map<string, unknown>;
  /** Radar pairs by id (unique on decisionAId + decisionBId, like `uq_radar_pairs_pair`). */
  radarPairs: Map<string, FakeRadarPair>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Stored pair plus the failure columns (`failed_hash`, `attempts`). */
export type FakeRadarPair = RadarPairRow & { failedHash?: string | null; attempts?: number };

export function fakeRepo(): FakeRepo {
  const repo: FakeRepo = {
    settings: clone(DEFAULT_SETTINGS),
    decisions: new Map(),
    assumptions: new Map(),
    tripwires: new Map(),
    evaluations: [],
    revisits: new Map(),
    relations: [],
    pageLocks: new Map(),
    versions: new Map(),
    appLocks: new Map(),
    appValues: new Map(),
    radarPairs: new Map(),

    async getSettings() {
      return clone(repo.settings);
    },
    async saveSettings(s) {
      repo.settings = clone(s);
    },

    async getDecisionByPage(pageId) {
      const found = [...repo.decisions.values()].find((d) => d.pageId === pageId);
      return found && clone(found);
    },
    async getDecision(id) {
      const found = repo.decisions.get(id);
      return found && clone(found);
    },
    async upsertDecision(d) {
      const existing = [...repo.decisions.values()].find((x) => x.pageId === d.pageId);
      const id = existing?.id ?? d.id ?? randomUUID();
      const row: DecisionRow = { ...clone(d), id, status: existing?.status ?? d.status };
      repo.decisions.set(id, row);
      return clone(row);
    },
    async markExtractError(pageId, error) {
      const existing = [...repo.decisions.values()].find((x) => x.pageId === pageId);
      if (existing) {
        existing.extractError = error;
        return;
      }
      const id = randomUUID();
      repo.decisions.set(id, { id, pageId, statement: '', topics: [], status: 'active', extractError: error });
    },

    async listAssumptions(decisionId) {
      return [...repo.assumptions.values()].filter((a) => a.decisionId === decisionId).map(clone);
    },
    async listTripwires(decisionId) {
      return [...repo.tripwires.values()].filter((t) => repo.assumptions.get(t.assumptionId)?.decisionId === decisionId).map(clone);
    },
    async hasConfirmedTripwires(decisionId) {
      return (await repo.listTripwires(decisionId)).some((t) => t.status !== 'proposed');
    },
    async replaceProposed(decisionId, items) {
      for (const t of await repo.listTripwires(decisionId)) if (t.status === 'proposed') repo.tripwires.delete(t.id);
      const kept = new Set([...repo.tripwires.values()].map((t) => t.assumptionId));
      for (const a of [...repo.assumptions.values()]) {
        if (a.decisionId === decisionId && !kept.has(a.id)) {
          repo.assumptions.delete(a.id);
          repo.relations = repo.relations.filter((r) => !(r.type === 'rests-on' && r.fromId === decisionId && r.toId === a.id));
        }
      }
      for (const item of items) {
        repo.assumptions.set(item.assumption.id, { ...clone(item.assumption), decisionId });
        repo.tripwires.set(item.tripwire.id, clone(item.tripwire));
      }
    },

    async getTripwireContext(id) {
      const tripwire = repo.tripwires.get(id);
      const assumption = tripwire && repo.assumptions.get(tripwire.assumptionId);
      const decision = assumption && repo.decisions.get(assumption.decisionId);
      if (!tripwire || !assumption || !decision) return undefined;
      return { tripwire: clone(tripwire), assumption: clone(assumption), decision: clone(decision) };
    },
    async listTripwireIdsForEvaluation(statuses, limit, offset) {
      return [...repo.tripwires.values()]
        .filter((t) => statuses.includes(t.status))
        .map((t) => t.id)
        .sort()
        .slice(offset, offset + limit);
    },
    async casTripwire(id, fromStatuses, patch, expect) {
      const current = repo.tripwires.get(id);
      if (!current || !fromStatuses.includes(current.status)) return false;
      if (expect?.strikes !== undefined && current.strikes !== expect.strikes) return false;
      if (expect?.baselineVersion !== undefined && current.baselineVersion !== expect.baselineVersion) return false;
      repo.versions.set(id, (repo.versions.get(id) ?? 0) + 1);
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      repo.tripwires.set(id, { ...current, ...clone(defined) } as TripwireRow);
      return true;
    },

    async insertEvaluation(e) {
      repo.evaluations.push(clone(e));
    },
    async listEvaluations(tripwireId, limit) {
      return repo.evaluations
        .filter((e) => e.tripwireId === tripwireId)
        .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(clone);
    },

    async findOpenRevisit(decisionId) {
      const found = [...repo.revisits.values()]
        .filter((r) => r.decisionId === decisionId && r.status === 'open')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return found && clone(found);
    },
    async getRevisitByIssue(issueKey) {
      const found = [...repo.revisits.values()].find((r) => r.issueKey === issueKey);
      return found && clone(found);
    },
    async insertRevisit(r) {
      if ([...repo.revisits.values()].some((x) => x.issueKey === r.issueKey)) throw new Error(`Duplicate revisit issue ${r.issueKey}`);
      repo.revisits.set(r.id, { ...clone(r), createdAt: new Date().toISOString() });
    },
    async closeRevisit(id, patch) {
      const current = repo.revisits.get(id);
      if (!current || current.status !== 'open') return false;
      repo.revisits.set(id, {
        ...current,
        status: 'closed',
        outcome: patch.outcome,
        resolvedBy: patch.resolvedBy,
        resolvedAt: new Date().toISOString(),
        newThreshold: patch.newThreshold,
        supersededByDecisionId: patch.supersededByDecisionId,
      });
      return true;
    },

    async insertRelation(r) {
      repo.relations.push({ ...clone(r), id: randomUUID(), createdAt: new Date().toISOString() });
    },

    async listWatchRows(statuses, limit, team) {
      const sec = (iso: string | null) => (iso ? Date.parse(iso) : -Infinity);
      const teamOf = (assumptionId: string): string | undefined => {
        const a = repo.assumptions.get(assumptionId);
        return (a && repo.decisions.get(a.decisionId)?.team)?.toLowerCase();
      };
      return [...repo.tripwires.values()]
        .filter((t) => statuses.includes(t.status))
        .filter((t) => !team || teamOf(t.assumptionId) === team.toLowerCase())
        .sort((a, b) => sec(b.lastEvaluatedAt) - sec(a.lastEvaluatedAt) || a.id.localeCompare(b.id))
        .slice(0, limit)
        .flatMap((t) => {
          const assumption = repo.assumptions.get(t.assumptionId);
          const decision = assumption && repo.decisions.get(assumption.decisionId);
          if (!assumption || !decision) return [];
          const open = [...repo.revisits.values()].find((r) => r.decisionId === decision.id && r.status === 'open');
          const { id, pageId, statement, title, team, ownerAccountId } = decision;
          return [
            {
              tripwire: clone(t),
              assumption: clone(assumption),
              decision: { id, pageId, statement, title, team, ownerAccountId },
              ...(open ? { revisitIssueKey: open.issueKey } : {}),
            },
          ];
        });
    },
    async deleteDecisionTree(decisionId) {
      const assumptionIds = [...repo.assumptions.values()].filter((a) => a.decisionId === decisionId).map((a) => a.id);
      const tripwireIds = [...repo.tripwires.values()].filter((t) => assumptionIds.includes(t.assumptionId)).map((t) => t.id);
      const revisitIds = [...repo.revisits.values()].filter((r) => r.decisionId === decisionId);
      const linked = new Set([decisionId, ...assumptionIds, ...revisitIds.map((r) => r.issueKey)]);
      const evaluations = repo.evaluations.filter((e) => tripwireIds.includes(e.tripwireId)).length;
      repo.evaluations = repo.evaluations.filter((e) => !tripwireIds.includes(e.tripwireId));
      repo.relations = repo.relations.filter((r) => !linked.has(r.fromId) && !linked.has(r.toId));
      for (const id of tripwireIds) repo.tripwires.delete(id);
      for (const r of revisitIds) repo.revisits.delete(r.id);
      for (const id of assumptionIds) repo.assumptions.delete(id);
      for (const p of [...repo.radarPairs.values()]) {
        if (p.decisionAId === decisionId || p.decisionBId === decisionId) repo.radarPairs.delete(p.id);
      }
      const page = repo.decisions.get(decisionId)?.pageId;
      repo.decisions.delete(decisionId);
      if (page) repo.pageLocks.delete(page);
      return { tripwires: tripwireIds.length, assumptions: assumptionIds.length, evaluations, revisits: revisitIds.length };
    },

    async acquirePageLock(pageId, lock, nowIso, seconds) {
      if (![...repo.decisions.values()].some((d) => d.pageId === pageId)) {
        const id = randomUUID();
        repo.decisions.set(id, { id, pageId, statement: '', topics: [], status: 'active' });
      }
      const locks = repo.pageLocks.get(pageId) ?? {};
      const until = locks[lock];
      // Second precision, like the TIMESTAMP column.
      const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
      if (until !== undefined && sec(until) > sec(nowIso)) return false;
      repo.pageLocks.set(pageId, { ...locks, [lock]: new Date(Date.parse(nowIso) + seconds * 1000).toISOString() });
      return true;
    },
    async releasePageLock(pageId, lock, heldUntil) {
      const locks = repo.pageLocks.get(pageId);
      // Second precision, like the TIMESTAMP column.
      const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
      const current = locks?.[lock];
      if (heldUntil !== undefined && (current === undefined || sec(current) !== sec(heldUntil))) return;
      if (locks) repo.pageLocks.set(pageId, { ...locks, [lock]: undefined });
    },
    async acquireAppLock(name, nowIso, seconds) {
      // Same key rule as `appKey` in sqlRepo, so an invalid lock name fails in tests too.
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || name === 'app') throw new Error(`Invalid app key: ${name}`);
      const until = repo.appLocks.get(name);
      if (until !== undefined && Date.parse(until) > Date.parse(nowIso)) return false;
      repo.appLocks.set(name, new Date(Date.parse(nowIso) + seconds * 1000).toISOString());
      return true;
    },
    async releaseAppLock(name) {
      repo.appLocks.delete(name);
    },
    async getAppValue(key) {
      return clone(repo.appValues.get(key));
    },
    async setAppValue(key, value) {
      repo.appValues.set(key, clone(value));
    },

    async countTripwiresByStatus() {
      const out: Partial<Record<TripwireStatus, number>> = {};
      for (const t of repo.tripwires.values()) out[t.status] = (out[t.status] ?? 0) + 1;
      return out;
    },
    async listRadarDecisions(limit) {
      return [...repo.decisions.values()]
        .filter((d) => d.status === 'active' && d.extractedAt && !d.extractError && d.statement !== '')
        .sort((a, b) => (b.extractedAt ?? '').localeCompare(a.extractedAt ?? '') || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(clone);
    },
    async listRadarAssessments() {
      return [...repo.radarPairs.values()].map(({ decisionAId, decisionBId, hashA, hashB, failedHash, attempts }) => ({
        decisionAId,
        decisionBId,
        hashA,
        hashB,
        failedHash: failedHash ?? null,
        attempts: attempts ?? 0,
      }));
    },
    async upsertRadarPair(p) {
      if (!(p.decisionAId < p.decisionBId)) throw new Error('radar pair must be ordered decision_a_id < decision_b_id');
      const now = new Date().toISOString();
      const existing = [...repo.radarPairs.values()].find((x) => x.decisionAId === p.decisionAId && x.decisionBId === p.decisionBId);
      if (existing) {
        repo.radarPairs.set(existing.id, {
          ...existing,
          ...clone(p),
          status: existing.status === 'dismissed' && existing.hashA === p.hashA && existing.hashB === p.hashB ? 'dismissed' : p.status,
          failedHash: null,
          attempts: 0,
          updatedAt: now,
        });
        return;
      }
      const id = randomUUID();
      repo.radarPairs.set(id, { ...clone(p), id, graph: null, graphFetchedAt: null, detectedAt: now, updatedAt: now, failedHash: null, attempts: 0 });
    },
    async recordRadarFailure(p) {
      if (!(p.decisionAId < p.decisionBId)) throw new Error('radar pair must be ordered decision_a_id < decision_b_id');
      const existing = [...repo.radarPairs.values()].find((x) => x.decisionAId === p.decisionAId && x.decisionBId === p.decisionBId);
      if (existing) {
        const attempts = existing.failedHash === p.failedHash ? (existing.attempts ?? 0) + 1 : 1;
        repo.radarPairs.set(existing.id, { ...existing, failedHash: p.failedHash, attempts });
        return;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      repo.radarPairs.set(id, {
        id,
        decisionAId: p.decisionAId,
        decisionBId: p.decisionBId,
        status: 'pending',
        confidence: 0,
        summary: '',
        sharedTopics: [],
        graph: null,
        graphFetchedAt: null,
        hashA: '',
        hashB: '',
        detectedAt: now,
        updatedAt: now,
        failedHash: p.failedHash,
        attempts: 1,
      });
    },
    async listRadarPairs(statuses, limit) {
      return [...repo.radarPairs.values()]
        .filter((p) => statuses.includes(p.status))
        .sort((x, y) => y.confidence - x.confidence || x.id.localeCompare(y.id))
        .slice(0, limit)
        .flatMap((p) => radarView(p));
    },
    async getRadarPair(id) {
      const p = repo.radarPairs.get(id);
      return p ? radarView(p)[0] : undefined;
    },
    async updateRadarPairGraph(id, graph, fetchedAt, keepOkSince) {
      const p = repo.radarPairs.get(id);
      if (!p) return false;
      const freshOk = p.graph?.state === 'ok' && p.graphFetchedAt !== null && keepOkSince !== undefined && Date.parse(p.graphFetchedAt) > Date.parse(keepOkSince);
      if (graph.state !== 'ok' && freshOk) return false;
      repo.radarPairs.set(id, { ...p, graph: clone(graph), graphFetchedAt: fetchedAt });
      return true;
    },
    async purgeLegacyRadarGraphs() {
      let n = 0;
      for (const p of repo.radarPairs.values()) {
        if (p.graph && 'a' in (p.graph as object)) {
          repo.radarPairs.set(p.id, { ...p, graph: null, graphFetchedAt: null });
          n += 1;
        }
      }
      return n;
    },
    async clearRadarGraphCache(decisionId) {
      let n = 0;
      for (const p of repo.radarPairs.values()) {
        if ((p.decisionAId === decisionId || p.decisionBId === decisionId) && p.graph && p.graph.state !== 'ok') {
          repo.radarPairs.set(p.id, { ...p, graph: null, graphFetchedAt: null });
          n += 1;
        }
      }
      return n;
    },
    async setDecisionPageVersion(pageId, from, to) {
      const d = [...repo.decisions.values()].find((x) => x.pageId === pageId);
      if (!d || d.pageVersion !== from) return false;
      repo.decisions.set(d.id, { ...d, pageVersion: to });
      return true;
    },
    async setRadarPairStatus(id, from, to) {
      const p = repo.radarPairs.get(id);
      if (!p || !from.includes(p.status)) return false;
      repo.radarPairs.set(id, { ...p, status: to });
      return true;
    },
  };

  /** Inner join with both decisions, like the SQL query. */
  const radarView = ({ failedHash: _f, attempts: _n, ...p }: FakeRadarPair): RadarPairView[] => {
    const a = repo.decisions.get(p.decisionAId);
    const b = repo.decisions.get(p.decisionBId);
    if (!a || !b) return [];
    const summary = (d: typeof a) => ({ id: d.id, pageId: d.pageId, title: d.title, statement: d.statement, team: d.team });
    return [{ pair: clone(p), a: summary(a), b: summary(b) }];
  };
  return repo;
}
