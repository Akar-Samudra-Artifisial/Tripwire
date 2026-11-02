import type { CheckinSpec, TriggerReading, ValidationResult } from '../types';
import { isRecord } from './common';

export const PERIOD_DAYS: Record<CheckinSpec['every'], number> = { month: 30, quarter: 91, year: 365 };
/** A check-in is reported as near this many days before it is due. */
export const CHECKIN_NEAR_DAYS = 7;
const DAY_MS = 86_400_000;

export function validate(spec: unknown): ValidationResult<CheckinSpec> {
  const errors: string[] = [];
  if (!isRecord(spec)) return { ok: false, errors: ['spec must be an object'] };
  if (spec.every !== 'month' && spec.every !== 'quarter' && spec.every !== 'year') {
    errors.push('every must be month, quarter or year');
  }
  if (typeof spec.question !== 'string' || spec.question.trim() === '') errors.push('question must be a non-empty string');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: { every: spec.every as CheckinSpec['every'], question: spec.question as string } };
}

/**
 * Value is the number of days until the next check-in is due (negative once overdue): near in the last
 * `CHECKIN_NEAR_DAYS` days of the period, tripped once a full period has passed since the owner last answered.
 * Without an answer the period starts now (the evaluator stores that as the first answer), so it never trips at once.
 */
export async function evaluate(spec: CheckinSpec, lastAnsweredAt?: string, now: Date = new Date()): Promise<TriggerReading> {
  const periodDays = PERIOD_DAYS[spec.every];
  const answered = lastAnsweredAt ? Date.parse(lastAnsweredAt) : Number.NaN;
  const daysSinceAnswer = Number.isNaN(answered) ? 0 : Math.floor((now.getTime() - answered) / DAY_MS);
  const daysLeft = periodDays - daysSinceAnswer;
  const outcome = daysLeft <= 0 ? 'tripped' : daysLeft <= CHECKIN_NEAR_DAYS ? 'near' : 'safe';
  const detail = Number.isNaN(answered)
    ? `not answered yet, first check-in due in ${periodDays} days`
    : `answered ${daysSinceAnswer} days ago, due every ${periodDays} days`;
  return { value: daysLeft, outcome, detail };
}
