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
 * Normally evaluated from the page-updated event; `baselineVersion` comes from the stored tripwire.
 */
export async function evaluate(spec: ContentChangeSpec, baselineVersion?: number): Promise<TriggerReading> {
  const version = await confluence.getPageVersion(spec.pageId);
  const changed = baselineVersion !== undefined && version > baselineVersion;
  return { value: version, outcome: changed ? 'tripped' : 'safe', detail: `page version ${version}` };
}
