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
  {
    name: 'v007_create_settings',
    statement: `CREATE TABLE IF NOT EXISTS settings (
      k VARCHAR(64) PRIMARY KEY,
      v JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  },
  // One ADD per ALTER: multi-clause ALTER TABLE is not guaranteed on Forge SQL.
  { name: 'v008a_decisions_title', statement: 'ALTER TABLE decisions ADD COLUMN IF NOT EXISTS title VARCHAR(255) NULL' },
  { name: 'v008b_decisions_page_version', statement: 'ALTER TABLE decisions ADD COLUMN IF NOT EXISTS page_version INT NULL' },
  { name: 'v008c_decisions_extracted_at', statement: 'ALTER TABLE decisions ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMP NULL' },
  { name: 'v008d_decisions_extract_error', statement: 'ALTER TABLE decisions ADD COLUMN IF NOT EXISTS extract_error TEXT NULL' },
  { name: 'v009a_tripwires_strikes', statement: 'ALTER TABLE tripwires ADD COLUMN IF NOT EXISTS strikes INT NOT NULL DEFAULT 0' },
  // IF NOT EXISTS everywhere (added to v008a–v009a later; names unchanged) so a run racing another invocation
  // (column added, name not yet recorded) can still complete. `last_value` is a reserved word in TiDB (window function) and must be backticked.
  { name: 'v009b_tripwires_last_value', statement: 'ALTER TABLE tripwires ADD COLUMN IF NOT EXISTS `last_value` DOUBLE NULL' },
  { name: 'v009c_tripwires_last_outcome', statement: 'ALTER TABLE tripwires ADD COLUMN IF NOT EXISTS last_outcome VARCHAR(16) NULL' },
  { name: 'v009d_tripwires_last_evaluated_at', statement: 'ALTER TABLE tripwires ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMP NULL' },
  { name: 'v009e_tripwires_baseline_version', statement: 'ALTER TABLE tripwires ADD COLUMN IF NOT EXISTS baseline_version INT NULL' },
  { name: 'v010_evaluations_detail', statement: 'ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS detail VARCHAR(255) NULL' },
  { name: 'v011a_revisits_tripwire_id', statement: 'ALTER TABLE revisits ADD COLUMN IF NOT EXISTS tripwire_id VARCHAR(36) NULL' },
  { name: 'v011b_revisits_status', statement: "ALTER TABLE revisits ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'open'" },
  { name: 'v011c_revisits_resolved_by', statement: 'ALTER TABLE revisits ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(128) NULL' },
  { name: 'v011d_revisits_resolved_at', statement: 'ALTER TABLE revisits ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP NULL' },
  { name: 'v011e_revisits_open_index', statement: 'ALTER TABLE revisits ADD INDEX IF NOT EXISTS idx_revisits_open (decision_id, status)' },
  // Per-page cooldown/locks (`Repo.acquirePageLock`) and an optimistic-lock counter for `casTripwire`.
  { name: 'v012_decisions_scan_cooldown_until', statement: 'ALTER TABLE decisions ADD COLUMN IF NOT EXISTS scan_cooldown_until TIMESTAMP NULL' },
  { name: 'v013_decisions_revisit_lock_until', statement: 'ALTER TABLE decisions ADD COLUMN IF NOT EXISTS revisit_lock_until TIMESTAMP NULL' },
  { name: 'v014_decisions_extract_lock_until', statement: 'ALTER TABLE decisions ADD COLUMN IF NOT EXISTS extract_lock_until TIMESTAMP NULL' },
  { name: 'v015_tripwires_version', statement: 'ALTER TABLE tripwires ADD COLUMN IF NOT EXISTS `version` INT NOT NULL DEFAULT 0' },
  // App-wide named locks (`Repo.acquireAppLock`), e.g. the demo seed buttons.
  {
    name: 'v016_create_app_locks',
    statement: `CREATE TABLE IF NOT EXISTS app_locks (
      name VARCHAR(64) PRIMARY KEY,
      until_at TIMESTAMP NULL
    )`,
  },
  // Radar: one row per assessed decision pair (decision_a_id < decision_b_id). `hash_a`/`hash_b` are the decision
  // fingerprints the verdict was made on, so an unchanged pair is never sent to the LLM again.
  {
    name: 'v017_create_radar_pairs',
    statement: `CREATE TABLE IF NOT EXISTS radar_pairs (
      id VARCHAR(36) PRIMARY KEY,
      decision_a_id VARCHAR(36) NOT NULL,
      decision_b_id VARCHAR(36) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      confidence DOUBLE NOT NULL DEFAULT 0,
      summary TEXT NULL,
      shared_topics JSON NULL,
      graph_json JSON NULL,
      graph_fetched_at TIMESTAMP NULL,
      hash_a VARCHAR(64) NOT NULL,
      hash_b VARCHAR(64) NOT NULL,
      detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_radar_pairs_pair (decision_a_id, decision_b_id),
      KEY idx_radar_pairs_status (status)
    )`,
  },
  // Radar: failed classifier attempts per pair, so a pair that keeps failing is retried a few times, then skipped
  // until one of its decisions changes (`failed_hash` = fingerprint of the failed version).
  { name: 'v018a_radar_pairs_failed_hash', statement: 'ALTER TABLE radar_pairs ADD COLUMN IF NOT EXISTS failed_hash VARCHAR(64) NULL' },
  { name: 'v018b_radar_pairs_attempts', statement: 'ALTER TABLE radar_pairs ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0' },
];

/** Name of the newest migration; `initialise` reports it so admins can confirm the schema is current. */
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? '';
