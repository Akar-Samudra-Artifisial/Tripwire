import type { TripwireKind, ValidationResult } from '../types';
import * as checkin from './checkin';
import * as contentChange from './content_change';
import * as date from './date';
import * as graphRelation from './graph_relation';
import * as jqlThreshold from './jql_threshold';

export { checkin, contentChange, date, graphRelation, jqlThreshold };

export const TRIPWIRE_KINDS: readonly TripwireKind[] = ['jql_threshold', 'graph_relation', 'date', 'content_change', 'checkin'];

export function isTripwireKind(value: unknown): value is TripwireKind {
  return typeof value === 'string' && (TRIPWIRE_KINDS as readonly string[]).includes(value);
}

/** Validates an untrusted spec (e.g. LLM output) against the schema of its kind. */
export function validateSpec(kind: TripwireKind, spec: unknown): ValidationResult<unknown> {
  switch (kind) {
    case 'jql_threshold':
      return jqlThreshold.validate(spec);
    case 'graph_relation':
      return graphRelation.validate(spec);
    case 'date':
      return date.validate(spec);
    case 'content_change':
      return contentChange.validate(spec);
    case 'checkin':
      return checkin.validate(spec);
  }
}
