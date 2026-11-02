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
  if (spec.resolved !== undefined && typeof spec.resolved !== 'boolean') return { ok: false, errors: ['resolved must be a boolean'] };
  return {
    ok: true,
    spec: { date: spec.date as string, leadDays: spec.leadDays as number, ...(spec.resolved === true ? { resolved: true } : {}) },
  };
}

/**
 * Value is the number of days left (negative once passed): near when 0 < days left ≤ leadDays, tripped on or
 * after the date. A date reaffirmed as handled (`resolved`) is one-shot and stays safe.
 */
export async function evaluate(spec: DateSpec, now: Date = new Date()): Promise<TriggerReading> {
  // `|| 0` turns Math.ceil's -0 (later on the due day) into 0.
  const daysLeft = Math.ceil((Date.parse(`${spec.date}T00:00:00Z`) - now.getTime()) / DAY_MS) || 0;
  if (spec.resolved) return { value: daysLeft, outcome: 'safe', detail: `${spec.date} was handled (resolved)` };
  const outcome = daysLeft <= 0 ? 'tripped' : daysLeft <= spec.leadDays ? 'near' : 'safe';
  const detail = daysLeft < 0 ? `${-daysLeft} days past ${spec.date}` : `${daysLeft} days until ${spec.date}`;
  return { value: daysLeft, outcome, detail };
}
