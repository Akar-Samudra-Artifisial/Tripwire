import type { TripwireKind } from './types';

/** One-line, human-readable form of a tripwire spec. Pure and dependency-free so Custom UI can bundle it. */
export function describeSpec(kind: TripwireKind, spec: unknown): string {
  const s = (typeof spec === 'object' && spec !== null ? spec : {}) as Record<string, unknown>;
  switch (kind) {
    case 'jql_threshold':
      return `Jira count for "${String(s.jql)}" trips when ${String(s.op)} ${String(s.value)}`;
    case 'graph_relation':
      return `${String(s.relation)} of ${String(s.anchor)} ${String(s.op)} ${String(s.value)}`;
    case 'date':
      return `Due ${String(s.date)} (warn ${String(s.leadDays)} days before)`;
    case 'content_change':
      return 'Any edit to this page';
    case 'checkin':
      return `Ask every ${String(s.every)}: ${String(s.question)}`;
  }
}

/** Fields of a stored tripwire that `formatReading` needs (kept structural so the UI can pass its own shape). */
export interface ReadingInput {
  kind: TripwireKind;
  spec: unknown;
  lastValue: number | null;
  lastEvaluatedAt: string | null;
}

/** Latest reading, e.g. `37 (measured 2026-11-02) · threshold > 10`; "not measured yet" before the first evaluation. */
export function formatReading(t: ReadingInput): string {
  const s = (typeof t.spec === 'object' && t.spec !== null ? t.spec : {}) as Record<string, unknown>;
  const value = t.lastValue === null ? 'not measured yet' : String(t.lastValue);
  const measured = t.lastValue !== null && t.lastEvaluatedAt ? ` (measured ${t.lastEvaluatedAt.slice(0, 10)})` : '';
  const threshold = t.kind === 'jql_threshold' || t.kind === 'graph_relation' ? ` · threshold ${String(s.op)} ${String(s.value)}` : '';
  return `${value}${measured}${threshold}`;
}
