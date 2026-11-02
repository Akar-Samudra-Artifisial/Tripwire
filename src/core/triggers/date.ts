import type { DateSpec, TriggerReading, ValidationResult } from '../types';
import { isRecord } from './common';

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validate(spec: unknown): ValidationResult<DateSpec> {
  const errors: string[] = [];
  if (!isRecord(spec)) return { ok: false, errors: ['spec must be an object'] };
  if (typeof spec.date !== 'string' || !ISO_DATE.test(spec.date) || Number.isNaN(Date.parse(spec.date))) {
    errors.push('date must be an ISO date (YYYY-MM-DD)');
  }
  if (typeof spec.leadDays !== 'number' || !Number.isInteger(spec.leadDays) || spec.leadDays < 0) {
    errors.push('leadDays must be a non-negative integer');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: { date: spec.date as string, leadDays: spec.leadDays as number } };
}

/** Value is the number of days left; near inside the lead window, tripped on or after the date. */
export async function evaluate(spec: DateSpec, now: Date = new Date()): Promise<TriggerReading> {
  const daysLeft = Math.ceil((Date.parse(`${spec.date}T00:00:00Z`) - now.getTime()) / DAY_MS);
  const outcome = daysLeft <= 0 ? 'tripped' : daysLeft <= spec.leadDays ? 'near' : 'safe';
  return { value: daysLeft, outcome, detail: `${daysLeft} days until ${spec.date}` };
}
