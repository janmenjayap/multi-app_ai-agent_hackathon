-- B04 scheduling and command acceptance share the application event transaction.
CREATE TABLE workflow_invocations (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
  runtime_attempt_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  schedule_status TEXT NOT NULL CHECK(schedule_status IN ('queued','running','waiting','stopped')),
  wake_at TEXT,
  deadline_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(runtime_attempt_id,run_id,evaluation_attempt_id) REFERENCES runtime_attempts(runtime_attempt_id,run_id,evaluation_attempt_id)
) STRICT;
CREATE INDEX workflow_due ON workflow_invocations(schedule_status,wake_at,deadline_at);

CREATE TABLE workflow_commands (
  command_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  operator_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('create','reconcile')),
  expected_revision INTEGER CHECK(expected_revision IS NULL OR expected_revision >= 0),
  accepted_at TEXT NOT NULL
) STRICT;
CREATE INDEX workflow_command_run ON workflow_commands(run_id,accepted_at);
CREATE TRIGGER workflow_commands_no_update BEFORE UPDATE ON workflow_commands BEGIN SELECT RAISE(ABORT,'immutable_command'); END;
CREATE TRIGGER workflow_commands_no_delete BEFORE DELETE ON workflow_commands BEGIN SELECT RAISE(ABORT,'immutable_command'); END;

-- Public projections include independently revised monitor results. Allocating
-- their revision must not emit another assessment job or invent a product event.
CREATE TABLE run_projections (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  fingerprint TEXT NOT NULL
) STRICT;
