import { randomUUID } from 'node:crypto';
import type { DecisionRow, EvaluationRow, PageLock, Repo, RevisitRow, TripwireRow } from '../../src/adapters/repo';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import type { Assumption, Relation } from '../../src/core/types';

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
}

const clone = <T>(v: T): T => structuredClone(v);

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
      if (!current) return;
      repo.revisits.set(id, {
        ...current,
        status: 'closed',
        outcome: patch.outcome,
        resolvedBy: patch.resolvedBy,
        resolvedAt: new Date().toISOString(),
        newThreshold: patch.newThreshold,
        supersededByDecisionId: patch.supersededByDecisionId,
      });
    },

    async insertRelation(r) {
      repo.relations.push({ ...clone(r), id: randomUUID(), createdAt: new Date().toISOString() });
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
    async releasePageLock(pageId, lock) {
      const locks = repo.pageLocks.get(pageId);
      if (locks) repo.pageLocks.set(pageId, { ...locks, [lock]: undefined });
    },
    async acquireAppLock(name, nowIso, seconds) {
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
  };
  return repo;
}
