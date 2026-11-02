/** Domain model shared by the evaluator, adapters and surfaces. Rows live in Forge SQL. */

export type DecisionStatus = 'active' | 'superseded';

export interface Decision {
  id: string;
  pageId: string;
  statement: string;
  ownerAccountId?: string;
  team?: string;
  decidedAt?: string;
  topics: string[];
  status: DecisionStatus;
}

export interface Assumption {
  id: string;
  decisionId: string;
  /** Exact quote from the decision page, so every tripwire can be traced back. */
  quote: string;
  summary: string;
}

export type TripwireKind = 'jql_threshold' | 'graph_relation' | 'date' | 'content_change' | 'checkin';

export type ComparisonOp = '>' | '>=' | '<' | '<=';

export interface JqlThresholdSpec {
  jql: string;
  op: ComparisonOp;
  value: number;
}

export interface GraphRelationSpec {
  anchor: string;
  relation: string;
  op: ComparisonOp;
  value: number;
}

export interface DateSpec {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  leadDays: number;
}

export interface ContentChangeSpec {
  pageId: string;
  watch: 'any_edit';
}

export interface CheckinSpec {
  every: 'month' | 'quarter' | 'year';
  question: string;
}

export interface TripwireSpecByKind {
  jql_threshold: JqlThresholdSpec;
  graph_relation: GraphRelationSpec;
  date: DateSpec;
  content_change: ContentChangeSpec;
  checkin: CheckinSpec;
}

export type TripwireStatus = 'proposed' | 'active' | 'near' | 'tripped' | 'revisiting' | 'archived';

export interface Tripwire<K extends TripwireKind = TripwireKind> {
  id: string;
  assumptionId: string;
  kind: K;
  spec: TripwireSpecByKind[K];
  status: TripwireStatus;
  confirmedBy?: string;
  confirmedAt?: string;
}

export type EvaluationOutcome = 'safe' | 'near' | 'tripped';

export interface Evaluation {
  id: string;
  tripwireId: string;
  value: number | null;
  evaluatedAt: string;
  outcome: EvaluationOutcome;
}

export type RevisitOutcome = 'reaffirm' | 'supersede';

export interface Revisit {
  id: string;
  decisionId: string;
  issueKey: string;
  outcome?: RevisitOutcome;
  newThreshold?: number;
  supersededByDecisionId?: string;
}

export type RelationType = 'rests-on' | 'invalidated-by' | 'contradicts' | 'superseded-by';

export interface Relation {
  id: string;
  type: RelationType;
  fromId: string;
  toId: string;
  createdAt: string;
}

export type ValidationResult<S> = { ok: true; spec: S } | { ok: false; errors: string[] };

/** Result of running a trigger once. `value` is null when the trigger has no numeric reading (e.g. checkin). */
export interface TriggerReading {
  value: number | null;
  outcome: EvaluationOutcome;
  detail?: string;
}
