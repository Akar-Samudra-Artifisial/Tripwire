/** Rovo action handlers for the Decision Steward agent. */

export interface ListTrippedPayload {
  team?: string;
  status?: string;
}

export interface TrippedDecision {
  decisionId: string;
  pageId: string;
  statement: string;
  status: 'tripped' | 'near';
}

/** Stub: returns an empty list until the evaluator writes results to Forge SQL. */
export async function listTripped(payload: ListTrippedPayload): Promise<{ decisions: TrippedDecision[]; note: string }> {
  const filters = [payload.team && `team=${payload.team}`, payload.status && `status=${payload.status}`].filter(Boolean);
  return {
    decisions: [],
    note: `Tripwire is not monitoring any decisions yet${filters.length ? ` (filters: ${filters.join(', ')})` : ''}.`,
  };
}
