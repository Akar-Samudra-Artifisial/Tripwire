/**
 * Initial Forge SQL schema. Forge SQL runs MySQL-compatible SQL, one statement per query and without
 * foreign keys, so referential integrity is enforced in code. Never edit an applied migration; append.
 */
export const MIGRATIONS: readonly { name: string; statement: string }[] = [
  {
    name: 'v001_create_decisions',
    statement: `CREATE TABLE IF NOT EXISTS decisions (
      id VARCHAR(36) PRIMARY KEY,
      page_id VARCHAR(32) NOT NULL,
      statement TEXT NOT NULL,
      owner_account_id VARCHAR(128) NULL,
      team VARCHAR(255) NULL,
      decided_at DATE NULL,
      topics JSON NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_decisions_page (page_id)
    )`,
  },
  {
    name: 'v002_create_assumptions',
    statement: `CREATE TABLE IF NOT EXISTS assumptions (
      id VARCHAR(36) PRIMARY KEY,
      decision_id VARCHAR(36) NOT NULL,
      quote TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_assumptions_decision (decision_id)
    )`,
  },
  {
    name: 'v003_create_tripwires',
    statement: `CREATE TABLE IF NOT EXISTS tripwires (
      id VARCHAR(36) PRIMARY KEY,
      assumption_id VARCHAR(36) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      spec JSON NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'proposed',
      confirmed_by VARCHAR(128) NULL,
      confirmed_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_tripwires_assumption (assumption_id),
      KEY idx_tripwires_status (status)
    )`,
  },
  {
    name: 'v004_create_evaluations',
    statement: `CREATE TABLE IF NOT EXISTS evaluations (
      id VARCHAR(36) PRIMARY KEY,
      tripwire_id VARCHAR(36) NOT NULL,
      value DOUBLE NULL,
      outcome VARCHAR(16) NOT NULL,
      evaluated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_evaluations_tripwire (tripwire_id, evaluated_at)
    )`,
  },
  {
    name: 'v005_create_revisits',
    statement: `CREATE TABLE IF NOT EXISTS revisits (
      id VARCHAR(36) PRIMARY KEY,
      decision_id VARCHAR(36) NOT NULL,
      issue_key VARCHAR(64) NOT NULL,
      outcome VARCHAR(16) NULL,
      new_threshold DOUBLE NULL,
      superseded_by_decision_id VARCHAR(36) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_revisits_decision (decision_id),
      UNIQUE KEY uq_revisits_issue (issue_key)
    )`,
  },
  {
    name: 'v006_create_relations',
    statement: `CREATE TABLE IF NOT EXISTS relations (
      id VARCHAR(36) PRIMARY KEY,
      type VARCHAR(32) NOT NULL,
      from_id VARCHAR(255) NOT NULL,
      to_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_relations_from (from_id, type),
      KEY idx_relations_to (to_id, type)
    )`,
  },
];
