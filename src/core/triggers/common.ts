import type { ComparisonOp, EvaluationOutcome } from '../types';

export const COMPARISON_OPS: readonly ComparisonOp[] = ['>', '>=', '<', '<='];

/** Share of the threshold at which a tripwire is reported as "near" (no revisit task yet). */
export const NEAR_RATIO = 0.8;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isComparisonOp(value: unknown): value is ComparisonOp {
  return typeof value === 'string' && (COMPARISON_OPS as readonly string[]).includes(value);
}

export function compare(value: number, op: ComparisonOp, threshold: number): boolean {
  switch (op) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
  }
}

/** Outcome for a numeric threshold: tripped when the condition holds, near at 80% of the way there. */
export function thresholdOutcome(value: number, op: ComparisonOp, threshold: number): EvaluationOutcome {
  if (compare(value, op, threshold)) return 'tripped';
  const rising = op === '>' || op === '>=';
  const near = rising ? value >= threshold * NEAR_RATIO : value <= threshold / NEAR_RATIO;
  return near ? 'near' : 'safe';
}
