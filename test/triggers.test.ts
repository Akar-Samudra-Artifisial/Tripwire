import { describe, expect, it } from 'vitest';
import { thresholdOutcome } from '../src/core/triggers/common';
import * as date from '../src/core/triggers/date';
import { validateSpec } from '../src/core/triggers';

describe('trigger validation', () => {
  it('accepts a valid jql_threshold spec and rejects an unknown op', () => {
    expect(validateSpec('jql_threshold', { jql: 'project = SUP', op: '>', value: 10 }).ok).toBe(true);
    expect(validateSpec('jql_threshold', { jql: 'project = SUP', op: '!=', value: 10 }).ok).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(validateSpec('date', { date: '30/06/2027', leadDays: 30 }).ok).toBe(false);
  });
});

describe('trigger evaluation', () => {
  it('reports near at 80% of a rising threshold and tripped past it', () => {
    expect(thresholdOutcome(7, '>', 10)).toBe('safe');
    expect(thresholdOutcome(8, '>', 10)).toBe('near');
    expect(thresholdOutcome(11, '>', 10)).toBe('tripped');
  });

  it('marks a date inside the lead window as near', async () => {
    const reading = await date.evaluate({ date: '2026-11-20', leadDays: 30 }, new Date('2026-11-02T00:00:00Z'));
    expect(reading.outcome).toBe('near');
    expect(reading.value).toBe(18);
  });
});
