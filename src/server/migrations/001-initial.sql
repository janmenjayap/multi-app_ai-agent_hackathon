-- Application ledger v1, F02 payloads v2. Preserve monitor PRAGMA user_version=1.
-- The opener applies this file and its checksum in one transaction.
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  incident_digest TEXT NOT NULL,
  incident_json TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_approval','safely_blocked','failed','failed_partial','completed','completed_no_affected_commitments')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(event_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id, issue_id)
) STRICT;
CREATE TABLE restricted_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  content_digest TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  media_type TEXT NOT NULL CHECK(media_type IN ('application/json','text/plain','message/rfc822')),
  content BLOB NOT NULL
) STRICT;
CREATE TABLE measurement_policies (
  evaluation_attempt_id TEXT PRIMARY KEY REFERENCES attempts(evaluation_attempt_id),
  lease_ms INTEGER NOT NULL CHECK(lease_ms BETWEEN 1 AND 86400000),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
  base_backoff_ms INTEGER NOT NULL CHECK(base_backoff_ms BETWEEN 1 AND 86400000),
  max_backoff_ms INTEGER NOT NULL CHECK(max_backoff_ms BETWEEN base_backoff_ms AND 86400000)
) STRICT;
CREATE TABLE runtime_attempts (
  runtime_attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
  started_at TEXT NOT NULL,
  UNIQUE(runtime_attempt_id,run_id,evaluation_attempt_id)
) STRICT;
CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  app TEXT NOT NULL CHECK(app IN ('github','hubspot','slack','gmail')),
  account_ref TEXT NOT NULL, relevant_version TEXT NOT NULL,
  captured_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
) STRICT;
CREATE TABLE plans (
  plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  plan_revision INTEGER NOT NULL CHECK(plan_revision > 0),
  plan_digest TEXT NOT NULL, plan_json TEXT NOT NULL,
  UNIQUE(run_id,plan_revision), UNIQUE(run_id,plan_digest)
) STRICT;
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  plan_revision INTEGER NOT NULL, plan_digest TEXT NOT NULL,
  workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, decision_message_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  decision_json TEXT NOT NULL,
  FOREIGN KEY(run_id,plan_revision) REFERENCES plans(run_id,plan_revision),
  UNIQUE(workspace_id,channel_id,decision_message_id)
) STRICT;
CREATE TABLE effects (
  effect_id TEXT PRIMARY KEY, effect_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  plan_revision INTEGER NOT NULL, request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('planned','inflight','applied','verified')),
  claim_id TEXT UNIQUE, provider_id TEXT, record_json TEXT NOT NULL,
  FOREIGN KEY(run_id,plan_revision) REFERENCES plans(run_id,plan_revision)
) STRICT;
CREATE TABLE effect_history (
  history_id INTEGER PRIMARY KEY, effect_key TEXT NOT NULL REFERENCES effects(effect_key),
  record_json TEXT NOT NULL
) STRICT;
CREATE TABLE role_invocations (
  invocation_id TEXT PRIMARY KEY, role_invocation_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  plan_revision INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('analyst','drafter','auditor')),
  context_json TEXT NOT NULL,
  UNIQUE(run_id,plan_revision,role)
) STRICT;
CREATE TABLE model_attempts (
  model_attempt_id TEXT PRIMARY KEY,
  role_invocation_key TEXT NOT NULL REFERENCES role_invocations(role_invocation_key),
  runtime_attempt_id TEXT NOT NULL REFERENCES runtime_attempts(runtime_attempt_id),
  started_at TEXT NOT NULL
) STRICT;
CREATE TABLE original_outputs (
  output_id TEXT PRIMARY KEY,
  model_attempt_id TEXT NOT NULL UNIQUE REFERENCES model_attempts(model_attempt_id),
  role_invocation_key TEXT NOT NULL REFERENCES role_invocations(role_invocation_key),
  first_output_id TEXT NOT NULL REFERENCES original_outputs(output_id),
  supersedes_id TEXT UNIQUE REFERENCES original_outputs(output_id),
  received_at TEXT NOT NULL,
  output_json TEXT NOT NULL
) STRICT;
CREATE TABLE role_results (
  result_id TEXT PRIMARY KEY, role_invocation_key TEXT NOT NULL UNIQUE REFERENCES role_invocations(role_invocation_key),
  result_json TEXT NOT NULL
) STRICT;
CREATE TABLE provider_attempts (
  provider_attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  runtime_attempt_id TEXT NOT NULL REFERENCES runtime_attempts(runtime_attempt_id),
  logical_call_id TEXT NOT NULL,
  effect_key TEXT REFERENCES effects(effect_key),
  app TEXT NOT NULL CHECK(app IN ('github','hubspot','slack','gmail')),
  account_ref TEXT NOT NULL, transport TEXT NOT NULL CHECK(transport IN ('fake','rest')),
  request_artifact_id TEXT NOT NULL REFERENCES restricted_artifacts(artifact_id),
  context_json TEXT NOT NULL, started_at TEXT NOT NULL
) STRICT;
CREATE TABLE provider_results (
  result_id TEXT PRIMARY KEY,
  provider_attempt_id TEXT NOT NULL UNIQUE REFERENCES provider_attempts(provider_attempt_id),
  outcome_json TEXT,
  receipt_json TEXT NOT NULL
) STRICT;
CREATE TABLE observations (
  observation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
  observation_json TEXT NOT NULL
) STRICT;
CREATE TABLE verifications (
  verification_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  effect_key TEXT NOT NULL REFERENCES effects(effect_key),
  observation_id TEXT NOT NULL REFERENCES observations(observation_id),
  provider_attempt_id TEXT NOT NULL REFERENCES provider_attempts(provider_attempt_id),
  verification_json TEXT NOT NULL
) STRICT;
CREATE TABLE reconciliations (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  effect_key TEXT NOT NULL REFERENCES effects(effect_key),
  observation_id TEXT NOT NULL REFERENCES observations(observation_id),
  record_json TEXT NOT NULL
) STRICT;
CREATE TABLE completion_claims (
  claim_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  event_id TEXT NOT NULL UNIQUE, claim_json TEXT NOT NULL
) STRICT;
CREATE TABLE corrections (
  correction_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  first_output_id TEXT NOT NULL REFERENCES original_outputs(output_id),
  supersedes_id TEXT NOT NULL, correction_json TEXT NOT NULL
) STRICT;
CREATE TABLE review_labels (
  label_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  output_id TEXT NOT NULL REFERENCES original_outputs(output_id),
  supersedes_id TEXT UNIQUE REFERENCES review_labels(label_id), label_json TEXT NOT NULL
) STRICT;
CREATE TABLE event_contexts (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  runtime_attempt_id TEXT NOT NULL,
  evaluation_attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  process_id TEXT NOT NULL, boot_id TEXT NOT NULL, monotonic_ms REAL NOT NULL,
  FOREIGN KEY(runtime_attempt_id,run_id,evaluation_attempt_id) REFERENCES runtime_attempts(runtime_attempt_id,run_id,evaluation_attempt_id),
  FOREIGN KEY(evaluation_attempt_id,event_id) REFERENCES events(evaluation_attempt_id,event_id),
  UNIQUE(run_id,sequence)
) STRICT;
CREATE INDEX effect_run_states ON effects(run_id,state);
CREATE INDEX role_output_history ON original_outputs(role_invocation_key,received_at);
CREATE INDEX run_event_cursor ON event_contexts(run_id,sequence);

-- Original receipts and histories are immutable, including through raw SQLite consumers.
CREATE TRIGGER reconciliations_no_update BEFORE UPDATE ON reconciliations BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER reconciliations_no_delete BEFORE DELETE ON reconciliations BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER restricted_artifacts_no_update BEFORE UPDATE ON restricted_artifacts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER restricted_artifacts_no_delete BEFORE DELETE ON restricted_artifacts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER measurement_policies_no_update BEFORE UPDATE ON measurement_policies BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER measurement_policies_no_delete BEFORE DELETE ON measurement_policies BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER runtime_attempts_no_update BEFORE UPDATE ON runtime_attempts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER runtime_attempts_no_delete BEFORE DELETE ON runtime_attempts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER plans_no_update BEFORE UPDATE ON plans BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER plans_no_delete BEFORE DELETE ON plans BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER effect_history_no_update BEFORE UPDATE ON effect_history BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER effect_history_no_delete BEFORE DELETE ON effect_history BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER role_invocations_no_update BEFORE UPDATE ON role_invocations BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER role_invocations_no_delete BEFORE DELETE ON role_invocations BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER model_attempts_no_update BEFORE UPDATE ON model_attempts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER model_attempts_no_delete BEFORE DELETE ON model_attempts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER original_outputs_no_update BEFORE UPDATE ON original_outputs BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER original_outputs_no_delete BEFORE DELETE ON original_outputs BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER role_results_no_update BEFORE UPDATE ON role_results BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER role_results_no_delete BEFORE DELETE ON role_results BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER provider_attempts_no_update BEFORE UPDATE ON provider_attempts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER provider_attempts_no_delete BEFORE DELETE ON provider_attempts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER provider_results_no_update BEFORE UPDATE ON provider_results BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER provider_results_no_delete BEFORE DELETE ON provider_results BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER verifications_no_update BEFORE UPDATE ON verifications BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER verifications_no_delete BEFORE DELETE ON verifications BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER completion_claims_no_update BEFORE UPDATE ON completion_claims BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER completion_claims_no_delete BEFORE DELETE ON completion_claims BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER corrections_no_update BEFORE UPDATE ON corrections BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER corrections_no_delete BEFORE DELETE ON corrections BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER review_labels_no_update BEFORE UPDATE ON review_labels BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER review_labels_no_delete BEFORE DELETE ON review_labels BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER event_contexts_no_update BEFORE UPDATE ON event_contexts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER event_contexts_no_delete BEFORE DELETE ON event_contexts BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER application_events_no_update BEFORE UPDATE ON events WHEN EXISTS(SELECT 1 FROM attempts WHERE evaluation_attempt_id=OLD.evaluation_attempt_id AND schema_version=2) BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER application_events_no_delete BEFORE DELETE ON events WHEN EXISTS(SELECT 1 FROM attempts WHERE evaluation_attempt_id=OLD.evaluation_attempt_id AND schema_version=2) BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TRIGGER application_attempt_identity BEFORE UPDATE OF evaluation_attempt_id,run_id,manifest_json,started_at_ms,schema_version ON attempts WHEN OLD.schema_version=2 BEGIN SELECT RAISE(ABORT, 'immutable_evaluation'); END;
