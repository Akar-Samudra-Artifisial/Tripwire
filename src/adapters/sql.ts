import { migrationRunner, sql } from '@forge/sql';
import { MIGRATIONS } from '../core/migrations';

/** Applies pending migrations; the runner records applied names, so this is safe to call repeatedly. */
export async function runMigrations(): Promise<string[]> {
  const runner = MIGRATIONS.reduce((r, m) => r.enqueue(m.name, m.statement), migrationRunner);
  return runner.run();
}

/** Parameterised SELECT; never interpolate values into `query`. */
export async function query<Row>(statement: string, ...params: unknown[]): Promise<Row[]> {
  const result = await sql.prepare<Row>(statement).bindParams(...params).execute();
  return result.rows as Row[];
}

/** Parameterised INSERT/UPDATE/DELETE; returns the number of affected rows. */
export async function execute(statement: string, ...params: unknown[]): Promise<number> {
  const result = await sql.prepare<{ affectedRows: number }>(statement).bindParams(...params).execute();
  const rows = result.rows as unknown as { affectedRows?: number };
  return rows.affectedRows ?? 0;
}
