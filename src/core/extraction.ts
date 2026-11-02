import { isTripwireKind, validateSpec } from './triggers';
import { isRecord } from './triggers/common';
import type { CheckinSpec, TripwireKind, TripwireSpecByKind } from './types';

export const MAX_ASSUMPTIONS = 8;
export const MAX_QUOTE = 500;
export const MAX_SUMMARY = 300;
export const MAX_JQL = 500;

/** Fields the extraction prompt allows in JQL (lower-case). */
export const JQL_FIELDS: readonly string[] = [
  'project',
  'labels',
  'issuetype',
  'status',
  'statuscategory',
  'priority',
  'component',
  'created',
  'resolved',
  'updated',
  'resolution',
  'assignee',
  'reporter',
];

/** Date functions the extraction prompt allows in JQL (lower-case). */
export const JQL_FUNCTIONS: readonly string[] = [
  'startofday',
  'startofweek',
  'startofmonth',
  'startofyear',
  'endofday',
  'endofweek',
  'endofmonth',
  'endofyear',
  'now',
];

export interface ParsedAssumption {
  quote: string;
  summary: string;
  kind: TripwireKind;
  spec: TripwireSpecByKind[TripwireKind];
  confidence?: number;
}

export interface ParsedDecision {
  statement: string;
  decidedAt?: string;
  team?: string;
  topics: string[];
}

export interface DroppedItem {
  index: number;
  reason: string;
  item?: unknown;
}

export interface RepairableItem {
  index: number;
  item: { quote: string; summary: string };
  errors: string[];
}

export interface ParsedExtraction {
  decision: ParsedDecision;
  assumptions: ParsedAssumption[];
  dropped: DroppedItem[];
  repairable: RepairableItem[];
}

export type AssumptionParse =
  | { ok: true; assumption: ParsedAssumption }
  | { ok: false; dropped: string }
  | { ok: false; repair: { quote: string; summary: string }; errors: string[] };

type JqlToken =
  | { t: 'word'; v: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' | 'rp' | 'comma'; v: string };

type JqlNode =
  | { type: 'and' | 'or'; items: JqlNode[] }
  | { type: 'not'; item: JqlNode }
  | { type: 'clause'; field: string; op: string; values: JqlValue[] };

type JqlValue = { kind: 'literal'; v: string } | { kind: 'function'; v: string };

class JqlReject extends Error {}

const JQL_OPS = ['!=', '!~', '>=', '<=', '=', '~', '>', '<'];
const JQL_RESERVED_VALUES = new Set(['and', 'or', 'not', 'in', 'is', 'order', 'by', 'was', 'changed']);
const JQL_MAX_DEPTH = 10;

function tokenizeJql(text: string): JqlToken[] {
  const tokens: JqlToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === ' ') {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j += 1;
        value += text[j] ?? '';
        j += 1;
      }
      if (j >= text.length) throw new JqlReject('jql has an unterminated quote');
      tokens.push({ t: 'str', v: value });
      i = j + 1;
      continue;
    }
    const op = JQL_OPS.find((o) => text.startsWith(o, i));
    if (op) {
      tokens.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      tokens.push({ t: c === '(' ? 'lp' : c === ')' ? 'rp' : 'comma', v: c });
      i += 1;
      continue;
    }
    const word = /^[A-Za-z0-9_.+-]+/.exec(text.slice(i));
    if (word) {
      tokens.push({ t: 'word', v: word[0] });
      i += word[0].length;
      continue;
    }
    const prev = tokens[tokens.length - 1];
    if (c === '[' && prev?.t === 'word' && prev.v.toLowerCase() === 'cf') throw new JqlReject('custom fields (cf[...]) are not allowed');
    throw new JqlReject(`character "${c}" is not allowed`);
  }
  return tokens;
}

class JqlParser {
  private pos = 0;
  constructor(private readonly tokens: JqlToken[]) {}

  parse(): JqlNode {
    const orderBy = this.tokens.findIndex((t, k) => isWord(t, 'order') && isWord(this.tokens[k + 1], 'by'));
    if (orderBy >= 0) throw new JqlReject('ORDER BY is not allowed');
    const node = this.or(0);
    const rest = this.tokens[this.pos];
    if (rest) throw new JqlReject(`unexpected "${rest.v}"`);
    return node;
  }

  private peek(): JqlToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): JqlToken {
    const t = this.tokens[this.pos];
    if (!t) throw new JqlReject('jql ends unexpectedly');
    this.pos += 1;
    return t;
  }

  private or(depth: number): JqlNode {
    const items = [this.and(depth)];
    while (isWord(this.peek(), 'or')) {
      this.pos += 1;
      items.push(this.and(depth));
    }
    return items.length === 1 ? (items[0] as JqlNode) : { type: 'or', items };
  }

  private and(depth: number): JqlNode {
    const items = [this.not(depth)];
    while (isWord(this.peek(), 'and')) {
      this.pos += 1;
      items.push(this.not(depth));
    }
    return items.length === 1 ? (items[0] as JqlNode) : { type: 'and', items };
  }

  private not(depth: number): JqlNode {
    if (isWord(this.peek(), 'not')) {
      this.pos += 1;
      return { type: 'not', item: this.not(depth) };
    }
    if (this.peek()?.t === 'lp') {
      if (depth >= JQL_MAX_DEPTH) throw new JqlReject('jql is nested too deeply');
      this.pos += 1;
      const inner = this.or(depth + 1);
      if (this.peek()?.t !== 'rp') throw new JqlReject('jql has an unbalanced parenthesis');
      this.pos += 1;
      return inner;
    }
    return this.clause();
  }

  private clause(): JqlNode {
    const fieldTok = this.next();
    if (fieldTok.t === 'str') throw new JqlReject('quoted field names are not allowed');
    if (fieldTok.t !== 'word') throw new JqlReject(`expected a field, got "${fieldTok.v}"`);
    const field = fieldTok.v.toLowerCase();
    if (field === 'key' || field === 'issuekey') throw new JqlReject('issue keys are not allowed');
    if (this.peek()?.t === 'lp') throw new JqlReject(`function ${fieldTok.v}() cannot be used as a field`);
    if (!JQL_FIELDS.includes(field)) throw new JqlReject(`field "${fieldTok.v}" is not allowed`);

    const opTok = this.next();
    if (opTok.t === 'op') return { type: 'clause', field, op: opTok.v, values: [this.value()] };
    if (opTok.t !== 'word') throw new JqlReject(`expected an operator after "${fieldTok.v}"`);
    const op = opTok.v.toLowerCase();
    if (op === 'was' || op === 'changed') throw new JqlReject(`history operator "${opTok.v}" is not allowed`);
    if (op === 'is') {
      const negated = isWord(this.peek(), 'not');
      if (negated) this.pos += 1;
      const empty = this.next();
      if (!(isWord(empty, 'empty') || isWord(empty, 'null'))) throw new JqlReject('IS must be followed by EMPTY or NULL');
      return { type: 'clause', field, op: negated ? 'is not' : 'is', values: [] };
    }
    let negated = false;
    if (op === 'not') {
      negated = true;
      if (!isWord(this.next(), 'in')) throw new JqlReject('NOT after a field must be followed by IN');
    } else if (op !== 'in') {
      throw new JqlReject(`operator "${opTok.v}" is not allowed`);
    }
    if (this.next().t !== 'lp') throw new JqlReject('IN must be followed by a list in parentheses');
    const values = [this.value()];
    while (this.peek()?.t === 'comma') {
      this.pos += 1;
      values.push(this.value());
    }
    if (this.next().t !== 'rp') throw new JqlReject('IN list is not closed');
    return { type: 'clause', field, op: negated ? 'not in' : 'in', values };
  }

  private value(): JqlValue {
    const t = this.next();
    if (t.t === 'str') return { kind: 'literal', v: t.v };
    if (t.t !== 'word') throw new JqlReject(t.t === 'lp' ? 'subqueries are not allowed' : `expected a value, got "${t.v}"`);
    if (this.peek()?.t === 'lp') {
      if (!JQL_FUNCTIONS.includes(t.v.toLowerCase())) throw new JqlReject(`function ${t.v}() is not allowed`);
      this.pos += 1;
      if (this.peek()?.t !== 'rp') {
        this.functionArg();
        while (this.peek()?.t === 'comma') {
          this.pos += 1;
          this.functionArg();
        }
      }
      if (this.next().t !== 'rp') throw new JqlReject(`function ${t.v}() is not closed`);
      return { kind: 'function', v: t.v };
    }
    if (JQL_RESERVED_VALUES.has(t.v.toLowerCase())) throw new JqlReject(`unexpected keyword "${t.v}"`);
    return { kind: 'literal', v: t.v };
  }

  private functionArg(): void {
    const t = this.next();
    if (t.t !== 'word' && t.t !== 'str') throw new JqlReject('function arguments must be plain values');
  }
}

function isWord(t: JqlToken | undefined, word: string): boolean {
  return t?.t === 'word' && t.v.toLowerCase() === word;
}

function topLevelConjuncts(node: JqlNode): JqlNode[] {
  return node.type === 'and' ? node.items.flatMap(topLevelConjuncts) : [node];
}

function projectClauses(node: JqlNode): Extract<JqlNode, { type: 'clause' }>[] {
  if (node.type === 'clause') return node.field === 'project' ? [node] : [];
  if (node.type === 'not') return projectClauses(node.item);
  return node.items.flatMap(projectClauses);
}

/**
 * Allowlist parser for LLM- or user-written JQL. Counts run as the app, so every query must be pinned
 * (top-level AND) to projects an admin allowed. Jira's strict `parseJql` still has the final word.
 */
export function jqlGuard(
  jql: unknown,
  allowedProjects: readonly string[],
): { ok: true; jql: string } | { ok: false; reason: string } {
  if (typeof jql !== 'string') return { ok: false, reason: 'jql must be a string' };
  const text = jql.trim();
  if (text === '') return { ok: false, reason: 'jql is empty' };
  if (text.length > MAX_JQL) return { ok: false, reason: `jql is longer than ${MAX_JQL} characters` };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'jql contains newlines or control characters' };
  const allowed = new Set(allowedProjects.map((k) => k.toUpperCase()));
  if (allowed.size === 0) return { ok: false, reason: 'no Jira project is allowed for JQL tripwires' };

  let tree: JqlNode;
  try {
    tree = new JqlParser(tokenizeJql(text)).parse();
  } catch (err) {
    if (err instanceof JqlReject) return { ok: false, reason: err.message };
    throw err;
  }

  const isAllowed = (v: JqlValue): boolean => v.kind === 'literal' && allowed.has(v.v.toUpperCase());
  const bad = projectClauses(tree).find((c) => !c.values.every(isAllowed));
  if (bad) return { ok: false, reason: `project must be one of ${[...allowed].join(', ')}` };
  const pinned = topLevelConjuncts(tree).some(
    (n) => n.type === 'clause' && n.field === 'project' && (n.op === '=' || n.op === 'in') && n.values.length > 0,
  );
  if (!pinned) return { ok: false, reason: 'jql must be limited with "project = KEY" or "project in (...)" joined by AND' };
  return { ok: true, jql: text };
}

function normaliseForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
}

/** True when `quote` appears in `text`, ignoring case, whitespace, curly quotes and a trailing full stop. */
export function quoteInText(quote: string, text: string): boolean {
  const q = normaliseForQuote(quote);
  return q.length > 0 && normaliseForQuote(text).includes(q);
}

/** True when two quotes are the same after the `quoteInText` normalisation. */
export function sameQuote(a: string, b: string): boolean {
  return normaliseForQuote(a) === normaliseForQuote(b);
}

/** Fallback for anything that cannot be measured automatically: ask the owner every quarter. */
export function toCheckin(summary: string): CheckinSpec {
  const clean = summary.trim().replace(/[.?!\s]+$/, '');
  return { every: 'quarter', question: `Is it still true that ${clean}?` };
}

const trimTo = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Validates one LLM assumption against the page (rules 1–8 of the extraction contract). */
export function parseAssumption(
  raw: unknown,
  pageText: string,
  pageId: string,
  allowedProjects: readonly string[],
): AssumptionParse {
  if (!isRecord(raw)) return { ok: false, dropped: 'not an object' };
  const quote = trimTo(raw.quote, MAX_QUOTE);
  const summary = trimTo(raw.summary, MAX_SUMMARY);
  if (quote === '' || summary === '' || raw.kind === undefined || raw.spec === undefined) {
    return { ok: false, dropped: 'missing quote, summary, kind or spec' };
  }
  if (!quoteInText(quote, pageText)) return { ok: false, dropped: 'quote not found' };
  if (!isTripwireKind(raw.kind)) return { ok: false, dropped: `unknown kind ${JSON.stringify(raw.kind).slice(0, 40)}` };

  const confidence =
    typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : undefined;
  const base = { quote, summary, ...(confidence !== undefined ? { confidence } : {}) };
  const checkin = (): AssumptionParse => ({ ok: true, assumption: { ...base, kind: 'checkin', spec: toCheckin(summary) } });

  const kind: TripwireKind = raw.kind;
  const spec: unknown = raw.spec;
  // No graph evaluator yet, and a content_change tripwire may only watch its own page.
  if (kind === 'graph_relation') return checkin();
  if (kind === 'content_change' && !(isRecord(spec) && spec.pageId === pageId)) return checkin();

  // Without an allowed project no count can be scoped safely, so measure it by asking instead.
  if (kind === 'jql_threshold' && allowedProjects.length === 0) return checkin();
  if (kind === 'jql_threshold') {
    const guard = jqlGuard(isRecord(spec) ? spec.jql : undefined, allowedProjects);
    if (!guard.ok) return { ok: false, repair: { quote, summary }, errors: [guard.reason] };
  }
  const valid = validateSpec(kind, spec);
  if (!valid.ok) {
    if (kind === 'checkin') return checkin();
    return { ok: false, repair: { quote, summary }, errors: valid.errors };
  }
  let validSpec = valid.spec as TripwireSpecByKind[TripwireKind];
  if (kind === 'jql_threshold') {
    const s = validSpec as TripwireSpecByKind['jql_threshold'];
    validSpec = { ...s, jql: s.jql.trim() };
  }
  return { ok: true, assumption: { ...base, kind, spec: validSpec } };
}

function parseDecision(raw: unknown, fallbackStatement: string): ParsedDecision {
  const d = isRecord(raw) ? raw : {};
  const statement = trimTo(d.statement, 500) || fallbackStatement.trim().slice(0, 500);
  const decidedAtRaw = typeof d.decidedAt === 'string' ? d.decidedAt.trim() : '';
  const decidedAt = /^\d{4}-\d{2}-\d{2}$/.test(decidedAtRaw) && !Number.isNaN(Date.parse(decidedAtRaw)) ? decidedAtRaw : undefined;
  const team = trimTo(d.team, 80) || undefined;
  const topicsRaw = Array.isArray(d.topics) ? d.topics : [];
  const topics = [...new Set(topicsRaw.map((t) => trimTo(t, 40)).filter((t) => t !== ''))].slice(0, 3);
  return { statement, topics, ...(decidedAt ? { decidedAt } : {}), ...(team ? { team } : {}) };
}

/** Turns untrusted `record_decision` arguments into validated assumptions; never throws. */
export function parseExtraction(
  raw: unknown,
  pageText: string,
  pageId: string,
  fallbackStatement: string,
  allowedProjects: readonly string[] = [],
): ParsedExtraction {
  const result: ParsedExtraction = { decision: parseDecision(undefined, fallbackStatement), assumptions: [], dropped: [], repairable: [] };
  if (!isRecord(raw)) {
    result.dropped.push({ index: -1, reason: 'extraction output is not an object', item: raw });
    return result;
  }
  result.decision = parseDecision(raw.decision, fallbackStatement);
  const items = Array.isArray(raw.assumptions) ? raw.assumptions : [];
  items.forEach((item: unknown, index) => {
    if (index >= MAX_ASSUMPTIONS) {
      result.dropped.push({ index, reason: 'over limit', item });
      return;
    }
    const parsed = parseAssumption(item, pageText, pageId, allowedProjects);
    if (parsed.ok) result.assumptions.push(parsed.assumption);
    else if ('repair' in parsed) result.repairable.push({ index, item: parsed.repair, errors: parsed.errors });
    else result.dropped.push({ index, reason: parsed.dropped, item });
  });
  return result;
}
