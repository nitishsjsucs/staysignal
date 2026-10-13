// WorkspaceAgent SQLite schema (SPEC 14.5). Created in onStart; every statement is idempotent.
export const WORKSPACE_DDL = [
  `CREATE TABLE IF NOT EXISTS results (result_id TEXT PRIMARY KEY, tool TEXT NOT NULL, owner TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS drafts (draft_id TEXT PRIMARY KEY, cohort_id TEXT NOT NULL, created_by TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reviews (review_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, cohort_id TEXT NOT NULL, proposer TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS approvals (subject_id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, proposer TEXT NOT NULL, proposer_kind TEXT NOT NULL, required_scope TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, subject_hash TEXT NOT NULL, workflow_instance_id TEXT, created_at TEXT NOT NULL, decided_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS forecast_runs (run_id TEXT PRIMARY KEY, version INTEGER NOT NULL, run_key TEXT NOT NULL, cutoff TEXT NOT NULL, vintage TEXT NOT NULL, model_version TEXT NOT NULL, metric_def TEXT NOT NULL, mapping TEXT NOT NULL, status TEXT NOT NULL, result_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, incident_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS published_pointer (scope TEXT PRIMARY KEY, run_id TEXT NOT NULL, action_seq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mapping_pointer (source TEXT PRIMARY KEY, version TEXT NOT NULL, action_seq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS action_log (seq INTEGER PRIMARY KEY, action_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, actor_kind TEXT NOT NULL, routine_run_id TEXT, payload_json TEXT NOT NULL, reason TEXT, reversible TEXT NOT NULL, reverses_seq INTEGER, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS approval_audit (seq INTEGER PRIMARY KEY, workflow_instance_id TEXT, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, proposer TEXT NOT NULL, decision TEXT NOT NULL, refusal_code TEXT, decided_by TEXT NOT NULL, decided_role TEXT NOT NULL, reason TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, decided_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS review_tasks (task_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, cohort_ref TEXT NOT NULL, category TEXT NOT NULL, owner_role TEXT NOT NULL, checks_json TEXT NOT NULL, evidence_json TEXT NOT NULL, blocking_items_json TEXT NOT NULL, status TEXT NOT NULL, created_by_seq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS engine_jobs (job_key TEXT PRIMARY KEY, kind TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL, lease_owner TEXT, lease_expires_at INTEGER, attempt INTEGER NOT NULL, result_json TEXT, workflow_instance_id TEXT, demo_epoch INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS incidents (incident_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS routine_runs (routine_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, trigger_json TEXT NOT NULL, steps_json TEXT NOT NULL, workflow_instance_id TEXT, demo_epoch INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, neurons INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory_files (path TEXT PRIMARY KEY, text TEXT NOT NULL, blob TEXT NOT NULL, commit_id TEXT NOT NULL, date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory_commits (seq INTEGER PRIMARY KEY, commit_id TEXT NOT NULL, parent TEXT, tree TEXT, message TEXT NOT NULL, date TEXT NOT NULL, files_json TEXT NOT NULL, imported INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS investigations (investigation_id TEXT PRIMARY KEY, routine_id TEXT, run_id TEXT NOT NULL, incident_id TEXT, status TEXT NOT NULL, brief_json TEXT NOT NULL, runs_json TEXT NOT NULL, merged_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS replays (run_id TEXT NOT NULL, replay_hash TEXT NOT NULL, equal INTEGER NOT NULL, duration_ms INTEGER NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS traces (trace_id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS anchors (day TEXT NOT NULL, chain TEXT NOT NULL, head_seq INTEGER NOT NULL, head_hash TEXT NOT NULL, anchored_in TEXT NOT NULL, PRIMARY KEY (day, chain))`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export const GENESIS_HASH = "0".repeat(64);
