-- Optional diagnostics have their own durable queue; no measurement row is changed.
CREATE TABLE trace_exports (
  export_id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES event_contexts(event_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  evaluation_attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  desired_run_id TEXT NOT NULL,
  parent_run_id TEXT,
  payload_json TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version = 1),
  lease_ms INTEGER NOT NULL CHECK(lease_ms BETWEEN 1 AND 86400000),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
  base_backoff_ms INTEGER NOT NULL CHECK(base_backoff_ms BETWEEN 1 AND 86400000),
  max_backoff_ms INTEGER NOT NULL CHECK(max_backoff_ms BETWEEN base_backoff_ms AND 86400000),
  status TEXT NOT NULL CHECK(status IN ('pending','leased','completed','exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0 AND attempts <= max_attempts),
  lease_token TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  remote_run_id TEXT,
  remote_url TEXT,
  error_code TEXT,
  FOREIGN KEY(evaluation_attempt_id,event_id) REFERENCES events(evaluation_attempt_id,event_id),
  FOREIGN KEY(run_id,sequence) REFERENCES event_contexts(run_id,sequence),
  UNIQUE(destination_id,run_id,evaluation_attempt_id,event_id),
  CHECK((status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status != 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK((status = 'completed' AND remote_run_id IS NOT NULL AND remote_run_id = desired_run_id)
    OR (status != 'completed' AND remote_run_id IS NULL AND remote_url IS NULL))
) STRICT;
CREATE INDEX trace_export_due ON trace_exports(destination_id,status,next_attempt_at,lease_expires_at);
CREATE INDEX trace_export_order ON trace_exports(destination_id,run_id,sequence,status);
CREATE INDEX trace_export_parent ON trace_exports(destination_id,run_id,desired_run_id,status);
CREATE TRIGGER trace_exports_source_scope BEFORE INSERT ON trace_exports
  WHEN NOT EXISTS(SELECT 1 FROM event_contexts WHERE event_id=NEW.event_id AND run_id=NEW.run_id
    AND evaluation_attempt_id=NEW.evaluation_attempt_id AND sequence=NEW.sequence)
  BEGIN SELECT RAISE(ABORT,'trace_export_source_mismatch'); END;
CREATE TRIGGER trace_exports_immutable_payload BEFORE UPDATE OF
  export_id,destination_id,event_id,run_id,evaluation_attempt_id,sequence,desired_run_id,parent_run_id,payload_json,
  policy_version,lease_ms,max_attempts,base_backoff_ms,max_backoff_ms,created_at
  ON trace_exports BEGIN SELECT RAISE(ABORT,'immutable_trace_export'); END;
CREATE TRIGGER trace_exports_no_delete BEFORE DELETE ON trace_exports
  BEGIN SELECT RAISE(ABORT,'immutable_trace_export'); END;
