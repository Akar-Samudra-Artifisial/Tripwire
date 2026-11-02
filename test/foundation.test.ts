import { describe, expect, it, vi } from 'vitest';
import { normaliseSettings, SettingsError } from '../src/core/settings';
import { fakeRepo } from './helpers/fakeRepo';

const sql = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('../src/adapters/sql', () => sql);

const { fromSqlTs, parseJsonColumn, sqlInt, sqlRepo, toSqlTs } = await import('../src/adapters/repo');

describe('normaliseSettings', () => {
  it('trims, upper-cases the project key, lower-cases the label and dedupes spaces', () => {
    expect(normaliseSettings({ revisitProjectKey: ' sup ', decisionLabel: 'Decision', watchedSpaceKeys: ['ENG', ' ENG', ''] })).toEqual({
      revisitProjectKey: 'SUP',
      decisionLabel: 'decision',
      watchedSpaceKeys: ['ENG'],
      allowedProjectKeys: ['SUP'],
    });
  });

  it('allowedProjectKeys defaults to the Revisit project, keeps an explicit empty list and validates keys (S1)', () => {
    expect(normaliseSettings({ revisitProjectKey: 'SUP' }).allowedProjectKeys).toEqual(['SUP']);
    expect(normaliseSettings({ revisitProjectKey: 'SUP', allowedProjectKeys: [] }).allowedProjectKeys).toEqual([]);
    expect(normaliseSettings({ allowedProjectKeys: [' sup', 'OPS', 'SUP'] }).allowedProjectKeys).toEqual(['SUP', 'OPS']);
    expect(() => normaliseSettings({ allowedProjectKeys: ['1AB'] })).toThrow(SettingsError);
    expect(() => normaliseSettings({ allowedProjectKeys: 'SUP' })).toThrow(SettingsError);
    expect(() => normaliseSettings({ allowedProjectKeys: Array.from({ length: 21 }, (_, i) => `P${i}`) })).toThrow(SettingsError);
  });

  it('falls back to defaults and rejects bad input', () => {
    expect(normaliseSettings(undefined)).toEqual({ decisionLabel: 'decision', watchedSpaceKeys: [], allowedProjectKeys: [] });
    expect(() => normaliseSettings({ revisitProjectKey: '1AB' })).toThrow(SettingsError);
    expect(() => normaliseSettings({ decisionLabel: 'two words' })).toThrow(SettingsError);
    expect(() => normaliseSettings({ watchedSpaceKeys: Array.from({ length: 21 }, (_, i) => `S${i}`) })).toThrow(SettingsError);
  });
});

describe('SQL column helpers', () => {
  it('round-trips timestamps as UTC and parses JSON strings or objects', () => {
    expect(toSqlTs('2026-11-02T08:30:15.123Z')).toBe('2026-11-02 08:30:15');
    expect(fromSqlTs('2026-11-02 08:30:15')).toBe('2026-11-02T08:30:15.000Z');
    expect(fromSqlTs(null)).toBeNull();
    expect(parseJsonColumn<string[]>('["a"]')).toEqual(['a']);
    expect(parseJsonColumn<string[]>(['a'])).toEqual(['a']);
  });
});

describe('MIGRATIONS', () => {
  it('every ALTER ADD is IF NOT EXISTS, one statement each, names unchanged (R1)', async () => {
    const { MIGRATIONS } = await import('../src/core/migrations');
    for (const m of MIGRATIONS.filter((x) => x.statement.startsWith('ALTER'))) {
      expect(m.statement, m.name).toMatch(/^ALTER TABLE \w+ ADD (COLUMN|INDEX) IF NOT EXISTS [`\w]/);
      expect(m.statement, m.name).not.toContain(';');
    }
    const names = MIGRATIONS.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['v008a_decisions_title', 'v009a_tripwires_strikes', 'v015_tripwires_version']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('backticks TiDB reserved words used as column names', async () => {
    const { MIGRATIONS } = await import('../src/core/migrations');
    const reserved = ['last_value', 'first_value', 'rank', 'row_number', 'lead', 'lag'];
    for (const m of MIGRATIONS) {
      for (const word of reserved) {
        expect(m.statement, m.name).not.toMatch(new RegExp(`(^|[^\`\\w])${word}([^\`\\w]|$)`, 'i'));
      }
    }
  });
});

describe('fakeRepo.casTripwire', () => {
  it('updates only when the current status is allowed', async () => {
    const repo = fakeRepo();
    repo.tripwires.set('t1', {
      id: 't1',
      assumptionId: 'a1',
      kind: 'checkin',
      spec: { every: 'month', question: 'Still true?' },
      status: 'proposed',
      strikes: 0,
      lastValue: null,
      lastOutcome: null,
      lastEvaluatedAt: null,
      baselineVersion: null,
    });
    expect(await repo.casTripwire('t1', ['active'], { status: 'near' })).toBe(false);
    expect(await repo.casTripwire('t1', ['proposed'], { status: 'active', confirmedBy: 'u1' })).toBe(true);
    expect(repo.tripwires.get('t1')).toMatchObject({ status: 'active', confirmedBy: 'u1' });
  });
});

describe('sqlRepo statements', () => {
  it('casTripwire bumps version and can match strikes (R5)', async () => {
    sql.execute.mockReset().mockResolvedValue(1);
    expect(await sqlRepo.casTripwire('t1', ['near'], { status: 'tripped', strikes: 2 }, { strikes: 1 })).toBe(true);
    const [statement, ...params] = sql.execute.mock.calls[0]!;
    expect(statement).toContain('`version` = `version` + 1');
    expect(statement).toMatch(/AND strikes = \?$/);
    expect(params).toEqual(['tripped', 2, 't1', 'near', 1]);
  });

  it('listEvaluations has a stable tie-breaker (R8)', async () => {
    sql.query.mockReset().mockResolvedValue([]);
    await sqlRepo.listEvaluations('t1', 5);
    expect(sql.query.mock.calls[0]![0]).toContain('ORDER BY evaluated_at DESC, id DESC');
  });

  it('inlines LIMIT/OFFSET as integers: Forge SQL rejects bound LIMIT parameters (ER_WRONG_ARGUMENTS)', async () => {
    sql.query.mockReset().mockResolvedValue([]);
    await sqlRepo.listEvaluations('t1', 10.7);
    await sqlRepo.listTripwireIdsForEvaluation(['active', 'near'], 501, 500);
    const [[evalSql, ...evalParams], [idsSql, ...idsParams]] = sql.query.mock.calls as [[string, ...unknown[]], [string, ...unknown[]]];
    expect(evalSql).toMatch(/LIMIT 10$/);
    expect(evalParams).toEqual(['t1']);
    expect(idsSql).toMatch(/LIMIT 501 OFFSET 500$/);
    expect(idsParams).toEqual(['active', 'near']);
    for (const [text] of sql.query.mock.calls) expect(text).not.toMatch(/(LIMIT|OFFSET) \?/);
  });

  it('sqlInt truncates, clamps and rejects non-finite values', () => {
    expect(sqlInt(5.9, 0, 10)).toBe(5);
    expect(sqlInt(-3, 0, 10)).toBe(0);
    expect(sqlInt(99, 0, 10)).toBe(10);
    expect(() => sqlInt(Number.NaN, 0, 10)).toThrow(TypeError);
    expect(() => sqlInt(Number.POSITIVE_INFINITY, 0, 10)).toThrow(TypeError);
    expect(() => sqlInt('5' as unknown as number, 0, 10)).toThrow(TypeError);
  });

  it('acquirePageLock ensures the row, then takes the lock only when it has run out', async () => {
    sql.execute.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await sqlRepo.acquirePageLock('p1', 'scan', '2026-11-02T09:00:00.000Z', 60)).toBe(false);
    expect(sql.execute.mock.calls[0]![0]).toContain('ON DUPLICATE KEY UPDATE');
    const [statement, ...params] = sql.execute.mock.calls[1]!;
    expect(statement).toContain('scan_cooldown_until IS NULL OR scan_cooldown_until <= ?');
    expect(params).toEqual(['2026-11-02 09:01:00', 'p1', '2026-11-02 09:00:00']);
  });
});

describe('fakeRepo.acquirePageLock', () => {
  it('blocks until the lock time has passed and frees on release', async () => {
    const repo = fakeRepo();
    expect(await repo.acquirePageLock('p1', 'scan', '2026-11-02T09:00:00.000Z', 60)).toBe(true);
    expect(await repo.acquirePageLock('p1', 'scan', '2026-11-02T09:00:59.000Z', 60)).toBe(false);
    expect(await repo.acquirePageLock('p1', 'extract', '2026-11-02T09:00:59.000Z', 60)).toBe(true);
    expect(await repo.acquirePageLock('p1', 'scan', '2026-11-02T09:01:00.000Z', 60)).toBe(true);
    await repo.releasePageLock('p1', 'extract');
    expect(await repo.acquirePageLock('p1', 'extract', '2026-11-02T09:01:00.000Z', 60)).toBe(true);
  });
});
