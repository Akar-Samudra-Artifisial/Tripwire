import { migrationRunner, sql } from '@forge/sql';
import { MIGRATIONS } from '../core/migrations';

/** Applies pending migrations; the runner records applied names, so this is safe to call repeatedly. */
export async function runMigrations(): Promise<string[]> {
  const runner = MIGRATIONS.reduce((r, m) => r.enqueue(m.name, m.statement), migrationRunner);
  return runner.run();
}

/**
 * Memoised migration runner. The memo is per isolate, so another invocation may be migrating at the same time:
 * on failure run once more (the runner skips names it already recorded, and every ALTER is IF NOT EXISTS).
 * A second failure clears the memo so the next call tries again.
 */
export function schemaGuard(migrate: () => Promise<string[]>): () => Promise<void> {
  let ready: Promise<string[]> | undefined;
  return async () => {
    ready ??= migrate()
      .catch((err: unknown) => {
        console.warn('tripwire migrations failed, retrying once', { error: err instanceof Error ? err.message : String(err) });
        return migrate();
      })
      .catch((err: unknown) => {
        ready = undefined;
        throw err;
      });
    await ready;
  };
}

/** Runs migrations once per warm invocation; call before any code that touches SQL. */
export const ensureSchema = schemaGuard(runMigrations);

/** Applied migration names, oldest first. Deduped: concurrent runs can record the same name twice. */
export async function listAppliedMigrations(): Promise<string[]> {
  const versions = await migrationRunner.list();
  return [...new Set(versions.map((v) => v.name))];
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
