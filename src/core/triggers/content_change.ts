import { confluence } from '../../adapters/confluence';
import type { ContentChangeSpec, TriggerReading, ValidationResult } from '../types';
import { isRecord } from './common';

export function validate(spec: unknown): ValidationResult<ContentChangeSpec> {
  const errors: string[] = [];
  if (!isRecord(spec)) return { ok: false, errors: ['spec must be an object'] };
  if (typeof spec.pageId !== 'string' || !/^\d+$/.test(spec.pageId)) errors.push('pageId must be a numeric Confluence page ID');
  if (spec.watch !== 'any_edit') errors.push('watch must be "any_edit"');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: { pageId: spec.pageId as string, watch: 'any_edit' } };
}

/**
 * Compares the watched page's current version with the version seen when the tripwire was confirmed.
 * Evaluated daily and right after the page-updated event; `baselineVersion` comes from the stored tripwire.
 * Without a baseline the reading is safe and the evaluator stores the current version as the baseline.
 */
export async function evaluate(spec: ContentChangeSpec, baselineVersion?: number): Promise<TriggerReading> {
  const version = await confluence.getPageVersion(spec.pageId);
  return contentChangeReading(version, baselineVersion);
}

/** Pure part of `evaluate`: tripped once the page version moved past the baseline. */
export function contentChangeReading(version: number, baselineVersion?: number): TriggerReading {
  if (baselineVersion === undefined) return { value: version, outcome: 'safe', detail: `page version ${version}, baseline set now` };
  const changed = version > baselineVersion;
  return {
    value: version,
    outcome: changed ? 'tripped' : 'safe',
    detail: changed ? `page edited: version ${version}, baseline ${baselineVersion}` : `page version ${version}, unchanged`,
  };
}
