import type { CheckinSpec, TriggerReading, ValidationResult } from '../types';
import { isRecord } from './common';

const PERIOD_DAYS: Record<CheckinSpec['every'], number> = { month: 30, quarter: 91, year: 365 };
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

/** A check-in is due (tripped) once a full period has passed since the owner last answered. */
export async function evaluate(spec: CheckinSpec, lastAnsweredAt?: string, now: Date = new Date()): Promise<TriggerReading> {
  if (!lastAnsweredAt) return { value: null, outcome: 'tripped', detail: 'never answered' };
  const days = Math.floor((now.getTime() - Date.parse(lastAnsweredAt)) / DAY_MS);
  return { value: null, outcome: days >= PERIOD_DAYS[spec.every] ? 'tripped' : 'safe', detail: `answered ${days} days ago` };
}
