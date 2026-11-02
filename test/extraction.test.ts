import { describe, expect, it } from 'vitest';
import { jqlGuard, parseExtraction, quoteInText, sameQuote, toCheckin } from '../src/core/extraction';

const DEMO_JQL = 'project = SUP AND labels = export AND created >= -30d';
const PAGE = 'We defer CSV export. We assume fewer than 10 customers a month ask for it. This page must not change.';

const jqlItem = (jql: string) => ({
  quote: 'fewer than 10 customers a month ask for it',
  summary: 'fewer than 10 customers a month ask for CSV export',
  kind: 'jql_threshold',
  spec: { jql, op: '>', value: 10 },
});

const ALLOWED = ['SUP'];

describe('jqlGuard', () => {
  it('accepts JQL pinned to an allowed project', () => {
    expect(jqlGuard(DEMO_JQL, ALLOWED)).toEqual({ ok: true, jql: DEMO_JQL });
    expect(
      jqlGuard('project in (sup) AND labels in ("export", csv) AND status not in (Done) AND created >= startOfMonth(-1)', ALLOWED).ok,
    ).toBe(true);
    expect(jqlGuard('(project = SUP AND labels = a) AND (labels = b OR status = Done) AND resolution IS EMPTY', ALLOWED).ok).toBe(true);
    expect(jqlGuard("project = 'SUP' AND NOT labels = export", ALLOWED).ok).toBe(true);
  });

  it.each([
    ['ORDER BY', `${DEMO_JQL} ORDER BY created DESC`, 'ORDER BY'],
    ['field outside the allowlist', 'project = SUP AND summary ~ "x"', 'field "summary"'],
    ['custom field cf[...]', 'project = SUP AND cf[10010] = 3', 'custom fields'],
    ['customfield_ name', 'project = SUP AND customfield_10010 = 3', 'field "customfield_10010"'],
    ['issue key', 'project = SUP AND key = SUP-1', 'issue keys'],
    ['issuekey', 'project = SUP AND issuekey in (SUP-1, SUP-2)', 'issue keys'],
    ['function outside the allowlist', 'project = SUP AND assignee = currentUser()', 'function currentUser()'],
    ['subquery via function field', 'project = SUP AND issueFunction in subtasksOf("x")', 'field "issueFunction"'],
    ['subquery in an IN list', 'project = SUP AND labels in (project = OTHER)', 'IN list'],
    ['nested list as value', 'project = SUP AND labels = (a)', 'subqueries'],
    ['history operator', 'project = SUP AND status WAS Done', 'history operator'],
    ['quoted custom field', 'project = SUP AND "Story Points" > 3', 'quoted field'],
    ['no project clause', 'labels = export AND created >= -30d', 'project ='],
    ['project only inside OR', 'project = SUP OR labels = export', 'project ='],
    ['negated project', 'NOT project = SUP AND labels = x', 'project ='],
    ['project not allowed', 'project = OPS AND labels = export', 'project must be one of SUP'],
    ['mixed allowed and other project', 'project in (SUP, OPS) AND labels = export', 'project must be one of SUP'],
    ['other project in an OR branch', 'project = SUP AND (labels = x OR project = OPS)', 'project must be one of SUP'],
    ['forbidden character', 'project = SUP & labels = x', 'character "&"'],
    ['unbalanced parenthesis', '(project = SUP AND labels = x', 'unbalanced'],
    ['too long', `project = SUP AND labels = ${'a'.repeat(500)}`, 'longer'],
    ['newline', 'labels = export\nAND project = SUP', 'newlines'],
    ['non-string', 42, 'string'],
  ])('rejects %s', (_label, jql, reason) => {
    const r = jqlGuard(jql, ALLOWED);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain(reason);
  });

  it('rejects every JQL when no project is allowed', () => {
    const r = jqlGuard(DEMO_JQL, []);
    expect(r.ok ? '' : r.reason).toContain('no Jira project');
  });
});

describe('quoteInText', () => {
  it('tolerates case, whitespace, curly quotes and a trailing full stop', () => {
    expect(quoteInText('Fewer  than 10 customers\na month ask for it.', PAGE)).toBe(true);
    expect(quoteInText('it’s “fine”', 'It\'s "fine" today')).toBe(true);
  });

  it('rejects quotes that are not on the page', () => {
    expect(quoteInText('more than 10 customers a month ask for it', PAGE)).toBe(false);
    expect(quoteInText('   ', PAGE)).toBe(false);
  });
});

describe('toCheckin', () => {
  it('asks every quarter', () => {
    expect(toCheckin('the team has capacity.')).toEqual({ every: 'quarter', question: 'Is it still true that the team has capacity?' });
  });
});

describe('parseExtraction', () => {
  it('drops everything and falls back to the page title when the output is not an object', () => {
    const r = parseExtraction('nope', PAGE, '123', 'Defer CSV export');
    expect(r.decision).toEqual({ statement: 'Defer CSV export', topics: [] });
    expect(r.assumptions).toEqual([]);
    expect(r.dropped).toHaveLength(1);
  });

  it('keeps a valid jql_threshold and parses the decision', () => {
    const r = parseExtraction(
      { decision: { statement: 'We defer CSV export', decidedAt: '2026-10-01', team: 'Growth', topics: ['csv', 'csv', 'export', 'a', 'b'] }, assumptions: [jqlItem(DEMO_JQL)] },
      PAGE,
      '123',
      'title',
      ALLOWED,
    );
    expect(r.decision).toEqual({ statement: 'We defer CSV export', decidedAt: '2026-10-01', team: 'Growth', topics: ['csv', 'export', 'a'] });
    expect(r.assumptions).toEqual([{ ...jqlItem(DEMO_JQL), kind: 'jql_threshold' }]);
  });

  it('drops unknown kinds and fake quotes', () => {
    const r = parseExtraction(
      { decision: { statement: 's' }, assumptions: [{ ...jqlItem(DEMO_JQL), kind: 'shell' }, { ...jqlItem(DEMO_JQL), quote: 'not on the page' }] },
      PAGE,
      '123',
      't',
    );
    expect(r.assumptions).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(['unknown kind "shell"', 'quote not found']);
  });

  it('turns graph_relation and foreign content_change into check-ins', () => {
    const r = parseExtraction(
      {
        decision: { statement: 's' },
        assumptions: [
          { quote: 'We defer CSV export', summary: 'few teams depend on export', kind: 'graph_relation', spec: { anchor: 'x', relation: 'y', op: '>', value: 3 } },
          { quote: 'This page must not change', summary: 'the page stays as is', kind: 'content_change', spec: { pageId: '999', watch: 'any_edit' } },
          { quote: 'This page must not change', summary: 'the page stays as is', kind: 'content_change', spec: { pageId: '123', watch: 'any_edit' } },
        ],
      },
      PAGE,
      '123',
      't',
    );
    expect(r.assumptions.map((a) => a.kind)).toEqual(['checkin', 'checkin', 'content_change']);
    expect(r.assumptions[0]?.spec).toEqual(toCheckin('few teams depend on export'));
  });

  it('marks broken JQL and invalid specs as repairable', () => {
    const r = parseExtraction(
      {
        decision: { statement: 's' },
        assumptions: [jqlItem('summary ~ "csv"'), { ...jqlItem(DEMO_JQL), spec: { jql: DEMO_JQL, op: 'about', value: 10 } }],
      },
      PAGE,
      '123',
      't',
      ALLOWED,
    );
    expect(r.assumptions).toEqual([]);
    expect(r.repairable.map((x) => x.index)).toEqual([0, 1]);
    expect(r.repairable[0]?.errors[0]).toContain('summary');
  });

  it('keeps at most 8 assumptions and ignores an invalid decidedAt', () => {
    const r = parseExtraction(
      { decision: { statement: 's', decidedAt: '2026-13-45' }, assumptions: Array.from({ length: 10 }, () => jqlItem(DEMO_JQL)) },
      PAGE,
      '123',
      't',
      ALLOWED,
    );
    expect(r.assumptions).toHaveLength(8);
    expect(r.dropped.filter((d) => d.reason === 'over limit')).toHaveLength(2);
    expect(r.decision.decidedAt).toBeUndefined();
  });

  it('turns jql_threshold into a check-in when no project is allowed (no repair call)', () => {
    const r = parseExtraction({ decision: { statement: 's' }, assumptions: [jqlItem(DEMO_JQL)] }, PAGE, '123', 't', []);
    expect(r.repairable).toEqual([]);
    expect(r.assumptions.map((a) => a.kind)).toEqual(['checkin']);
  });

  it('sends JQL for a project outside the allowlist to repair', () => {
    const r = parseExtraction({ decision: { statement: 's' }, assumptions: [jqlItem('project = OPS AND labels = x')] }, PAGE, '123', 't', ALLOWED);
    expect(r.repairable[0]?.errors[0]).toContain('project must be one of SUP');
  });
});

describe('sameQuote', () => {
  it('matches quotes that differ only by case, spacing and a trailing full stop', () => {
    expect(sameQuote('Fewer than 10  customers.', 'fewer than 10 customers')).toBe(true);
    expect(sameQuote('fewer than 10 customers', 'fewer than 20 customers')).toBe(false);
  });
});
