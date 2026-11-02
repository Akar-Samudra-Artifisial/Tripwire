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
      return `Due ${String(s.date)} (warn ${String(s.leadDays)} days before)${s.resolved === true ? ' · handled' : ''}`;
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
  /** Last check-in answer (checkin only). */
  confirmedAt?: string | null;
  /** Page version accepted as unchanged (content_change only). */
  baselineVersion?: number | null;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Kind-specific text for a reading; `v` is days left (date, checkin) or the page version (content_change). */
function readingText(t: ReadingInput, s: Record<string, unknown>, v: number): string {
  switch (t.kind) {
    case 'date': {
      if (s.resolved === true) return `${String(s.date)} handled`;
      if (v > 0) return `${plural(v, 'day')} left until ${String(s.date)}`;
      return v === 0 ? `due today (${String(s.date)})` : `${plural(-v, 'day')} past ${String(s.date)}`;
    }
    case 'checkin':
      if (v > 0) return `next check-in due in ${plural(v, 'day')}`;
      return v === 0 ? 'check-in due today' : `check-in overdue by ${plural(-v, 'day')}`;
    case 'content_change': {
      const base = t.baselineVersion;
      if (base === null || base === undefined) return `page version ${v}`;
      return v > base ? `page edited: version ${v} (accepted ${base})` : `page version ${v}, unchanged`;
    }
    default:
      return String(v);
  }
}

/**
 * Latest reading, e.g. `37 (measured 2026-11-02) · threshold > 10`, `3 days left until 2027-03-31 (measured …)`
 * or `check-in overdue by 1 day (measured …)`; "not measured yet" before the first evaluation.
 */
export function formatReading(t: ReadingInput): string {
  const s = (typeof t.spec === 'object' && t.spec !== null ? t.spec : {}) as Record<string, unknown>;
  const measured = t.lastValue !== null && t.lastEvaluatedAt ? ` (measured ${t.lastEvaluatedAt.slice(0, 10)})` : '';
  if (t.kind === 'jql_threshold' || t.kind === 'graph_relation') {
    const value = t.lastValue === null ? 'not measured yet' : String(t.lastValue);
    return `${value}${measured} · threshold ${String(s.op)} ${String(s.value)}`;
  }
  if (t.lastValue === null) {
    return t.kind === 'checkin' && t.confirmedAt ? `last answered ${t.confirmedAt.slice(0, 10)}` : 'not measured yet';
  }
  return `${readingText(t, s, t.lastValue)}${measured}`;
}
