import type { TripwireRow } from '../../src/adapters/repo';
import type { TripwireStatus } from '../../src/core/types';
import type { FakeRepo } from './fakeRepo';

export const DEMO_JQL = 'project = SUP AND labels = export AND created >= -30d';

let counter = 0;

/** Seeds one decision page with a confirmed `jql_threshold` tripwire (`> 10`) and returns its ids. */
export function seedTripwire(
  repo: FakeRepo,
  opts: { status?: TripwireStatus; strikes?: number; decisionId?: string; statement?: string; quote?: string } = {},
): { decisionId: string; assumptionId: string; tripwireId: string } {
  counter += 1;
  const decisionId = opts.decisionId ?? `dec-${counter}`;
  if (!repo.decisions.has(decisionId)) {
    repo.decisions.set(decisionId, {
      id: decisionId,
      pageId: `${98000 + counter}`,
      statement: opts.statement ?? 'We decided to defer CSV export to next year.',
      title: 'Defer CSV export',
      ownerAccountId: 'owner-1',
      topics: ['CSV export'],
      status: 'active',
    });
  }
  const assumptionId = `asm-${counter}`;
  repo.assumptions.set(assumptionId, {
    id: assumptionId,
    decisionId,
    quote: opts.quote ?? 'fewer than 10 customers a month ask for it',
    summary: 'fewer than 10 customers a month ask for CSV export',
  });
  const tripwireId = `tw-${counter}`;
  const tripwire: TripwireRow = {
    id: tripwireId,
    assumptionId,
    kind: 'jql_threshold',
    spec: { jql: DEMO_JQL, op: '>', value: 10 },
    status: opts.status ?? 'active',
    confirmedBy: 'owner-1',
    confirmedAt: '2026-10-01T00:00:00.000Z',
    strikes: opts.strikes ?? 0,
    lastValue: null,
    lastOutcome: null,
    lastEvaluatedAt: null,
    baselineVersion: null,
  };
  repo.tripwires.set(tripwireId, tripwire);
  return { decisionId, assumptionId, tripwireId };
}
