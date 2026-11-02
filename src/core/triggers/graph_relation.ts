import { teamworkGraph } from '../../adapters/teamworkGraph';
import type { GraphRelationSpec, TriggerReading, ValidationResult } from '../types';
import { isComparisonOp, isRecord, thresholdOutcome } from './common';

export function validate(spec: unknown): ValidationResult<GraphRelationSpec> {
  const errors: string[] = [];
  if (!isRecord(spec)) return { ok: false, errors: ['spec must be an object'] };
  if (typeof spec.anchor !== 'string' || spec.anchor.trim() === '') errors.push('anchor must be a non-empty string');
  if (typeof spec.relation !== 'string' || spec.relation.trim() === '') errors.push('relation must be a non-empty string');
  if (!isComparisonOp(spec.op)) errors.push('op must be one of >, >=, <, <=');
  if (typeof spec.value !== 'number' || !Number.isFinite(spec.value)) errors.push('value must be a finite number');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      anchor: spec.anchor as string,
      relation: spec.relation as string,
      op: spec.op as GraphRelationSpec['op'],
      value: spec.value as number,
    },
  };
}

/** Counts Teamwork Graph objects related to the anchor. Stub: the graph adapter is not wired yet. */
export async function evaluate(spec: GraphRelationSpec): Promise<TriggerReading> {
  const count = await teamworkGraph.countRelated(spec.anchor, spec.relation);
  return { value: count, outcome: thresholdOutcome(count, spec.op, spec.value), detail: `${count} ${spec.relation}` };
}
