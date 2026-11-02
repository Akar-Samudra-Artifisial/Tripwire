import { jira } from '../../adapters/jira';
import type { JqlThresholdSpec, TriggerReading, ValidationResult } from '../types';
import { isComparisonOp, isRecord, thresholdOutcome } from './common';

export function validate(spec: unknown): ValidationResult<JqlThresholdSpec> {
  const errors: string[] = [];
  if (!isRecord(spec)) return { ok: false, errors: ['spec must be an object'] };
  if (typeof spec.jql !== 'string' || spec.jql.trim() === '') errors.push('jql must be a non-empty string');
  if (!isComparisonOp(spec.op)) errors.push('op must be one of >, >=, <, <=');
  if (typeof spec.value !== 'number' || !Number.isFinite(spec.value)) errors.push('value must be a finite number');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: { jql: spec.jql as string, op: spec.op as JqlThresholdSpec['op'], value: spec.value as number } };
}

/** Counts matching Jira issues and compares the count with the threshold. */
export async function evaluate(spec: JqlThresholdSpec): Promise<TriggerReading> {
  const count = await jira.countIssues(spec.jql);
  return { value: count, outcome: thresholdOutcome(count, spec.op, spec.value), detail: `${count} issues, threshold ${spec.op} ${spec.value}` };
}
