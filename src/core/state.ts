import type { EvaluationOutcome, TripwireKind, TripwireStatus } from './types';

/** Consecutive tripped readings needed before a numeric tripwire trips (filters one-off spikes). */
export const STRIKES_TO_TRIP = 2;

/**
 * Tripped readings needed per kind. Counts can spike, so numeric kinds need two in a row; a passed date, an
 * overdue check-in or an edited page do not flicker, so one reading trips them.
 */
export function strikesToTrip(kind: TripwireKind): number {
  return kind === 'jql_threshold' || kind === 'graph_relation' ? STRIKES_TO_TRIP : 1;
}

/** Statuses the daily evaluator reads; `proposed` and `archived` are never evaluated. */
export const EVALUABLE_STATUSES: readonly TripwireStatus[] = ['active', 'near', 'tripped', 'revisiting'];

export interface StateInput {
  status: TripwireStatus;
  strikes: number;
}

export interface StateResult {
  status: TripwireStatus;
  strikes: number;
  /** True when the caller should open a Revisit (or retry opening one) for the decision. */
  openRevisit: boolean;
}

/** Pure tripwire state machine: previous state + one evaluation outcome → next state. */
export function nextState(prev: StateInput, outcome: EvaluationOutcome, kind: TripwireKind = 'jql_threshold'): StateResult {
  if (!EVALUABLE_STATUSES.includes(prev.status)) throw new Error('not evaluable');

  if (prev.status === 'revisiting') {
    return { status: 'revisiting', strikes: outcome === 'tripped' ? prev.strikes + 1 : 0, openRevisit: false };
  }

  if (outcome === 'safe') return { status: 'active', strikes: 0, openRevisit: false };
  if (outcome === 'near') return { status: 'near', strikes: 0, openRevisit: false };

  const strikes = prev.strikes + 1;
  if (prev.status === 'tripped' || strikes >= strikesToTrip(kind)) return { status: 'tripped', strikes, openRevisit: true };
  return { status: 'near', strikes, openRevisit: false };
}
