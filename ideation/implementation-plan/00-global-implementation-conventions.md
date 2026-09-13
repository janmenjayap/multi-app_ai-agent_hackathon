# PromiseGuard global implementation conventions

**Status:** normative implementation contract
**Version:** 1.1
**Applies to:** every P00, F-series, B-series, I-series, A-series,
U-series, Q-series, and R-series branch and commit
**Owners:** P1 owns this document and shared-contract changes; P2, P3, and P4
must review changes that affect their boundaries.

This document defines the naming, repository layout, data-shape, ownership,
and handoff rules that keep independently implemented branches compatible. The
words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative.

Every implementation owner MUST read this document with the applicable branch
plan and commit brief. Every handoff MUST record the conventions version used;
silence does not exempt a branch from these rules.

## 1. Authority and conflict resolution

Use the following authority order. A lower item cannot silently redefine a
higher item.

1. Current official event and submission requirements govern eligibility,
   deadlines, and delivery constraints.
2. [The final project definition](../final-project-promiseguard.md) governs
   product scope: one PromiseGuard application using GitHub, HubSpot, Slack,
   and Gmail.
3. [The demo and reliability contract](../demo-scenarios-and-reliability.md)
   governs scenarios, expected outcomes, evidence, metrics, and demo claims.
4. [The architecture](../promiseguard-architecture.md) governs system
   boundaries, authority, storage, execution, and verification.
5. This document governs global naming, paths, schema conventions, ownership,
   and branch/commit hygiene.
6. [The shared-contract plan](05-contracts-and-handoffs.md), followed by the
   reviewed F02 implementation, governs exact public TypeScript and runtime
   schemas. Once F02 is merged, its versioned executable schemas are the source
   of truth for payload shape.
7. An individual [commit brief](commits/README.md) governs that commit's hard
   prerequisites, allowed files, acceptance tests, and handoff. A
   [branch plan](branches/README.md) governs branch-local sequencing.
8. [The merge runbook](10-parallel-branch-and-merge-runbook.md) governs
   scheduling when it does not conflict with an individual commit brief.
9. [Global Scale](Global%20Scale.md) records observed completion and evidence;
   it does not define behavior.
10. The dated audit records what was observed at that time; it does not turn a
    planned capability into an implemented capability.

When two sources still conflict, the branch MUST stop at the boundary, record
the conflict in its handoff, and obtain the owning reviewers' decision. Safety
uses the stricter interpretation in the meantime. No branch may resolve a
contract conflict by adding a private duplicate type, alias, path, or status.

## 2. Non-negotiable product invariants

Every implementation MUST preserve these invariants.

1. The business apps are exactly `github`, `hubspot`, `slack`, and `gmail`.
   MCP is an optional transport, not a fifth business app.
2. Gmail creates and reads drafts only. Runtime code MUST NOT expose send,
   delete, or arbitrary mailbox mutation.
3. The model roles are exactly `analyst`, `drafter`, and `auditor`.
   Deterministic code owns selection, recipient choice, approval, execution,
   idempotency, verification, and completion.
4. Agents receive narrow projections and no provider credentials, generic HTTP
   tools, mutation registry, or authority-bearing browser state.
5. Authentic Slack approval is bound to one immutable plan revision, source
   state, actor, workspace, channel, thread, message, and expiry. Transport
   success is never business approval.
6. Protected writes for one run are sequential. Each write is independently
   read back before the workflow advances.
7. An uncertain write is reconciled or the run stops. It is never blindly
   retried.
8. A success claim is emitted only after its required independent evidence is
   present. A create response or cached executor value is not readback proof.
9. Original model outputs, source snapshots, attempts, approvals, observations,
   claims, and corrections are append-only. A correction never erases the first
   proposal used by quality metrics.
10. `completed_no_affected_commitments` requires complete source retrieval,
    deterministic empty selection, and independent absence evidence. It creates
    no plan, requests no approval, performs no protected write, and requires no
    final Slack summary.
11. Synthetic, fake-provider, live-model, live-provider, and human-reviewed
    evidence remain separately identified. Configuration strings cannot promote
    untrusted evidence to trusted evidence.
12. Missing, incomplete, unknown, unverified, contradicted, failed, and zero are
    different states. Code and UI MUST NOT collapse them.

## 3. Global lexical rules

### 3.1 Product and provider names

- Product/display name: `PromiseGuard`.
- Provider display names: `GitHub`, `HubSpot`, `Slack`, `Gmail`.
- Provider identifiers in code and data: `github`, `hubspot`, `slack`,
  `gmail`.
- Do not introduce `Github`, `Git Hub`, `hub_spot`, `email`, or `google_mail`
  as aliases for these concepts.
- Use `commitment`, not `customer`, as the selected business obligation. A
  customer/company/contact is an associated entity, not the selection unit.
- Use `incident` for the GitHub-backed incident and `run` for one logical
  PromiseGuard workflow record. Do not use `job`, `task`, and `run`
  interchangeably; a HubSpot task and a measurement job are distinct concepts.

### 3.2 TypeScript and JSON

- Types, interfaces, classes, enums, React components, and schema exports use
  `PascalCase`: `RuntimeAttemptId`, `ImmutablePlan`, `RunView`.
- Functions, methods, variables, object properties, and JSON fields use
  `camelCase`: `runtimeAttemptId`, `planRevision`, `observedAt`.
- Constants use `UPPER_SNAKE_CASE`: `DEFAULT_APPROVAL_TTL_MS`.
- String discriminants and persisted enum values use `lower_snake_case`:
  `awaiting_approval`, `failed_partial`, `no_affected`.
- Environment variables use the `PG_` prefix and `UPPER_SNAKE_CASE`, except
  standard vendor variables such as `OPENAI_API_KEY`.
- Boolean names MUST read as predicates: `isComplete`, `hasMore`,
  `wasApplied`. Avoid ambiguous names such as `completeFlag`.
- Collection names are plural; one-item entity names are singular.
- Use `Id` in TypeScript names and `id` in JSON fields, never `ID` or `Uuid`:
  `claimId`, `sourceSnapshotIds`.
- Acronyms are treated as words in symbols: `GithubAdapter`, `McpBinding`,
  `ApiError`. Provider display strings retain official capitalization.
- Public contracts MUST use named fields. Positional tuples are not allowed at
  module, persistence, API, or evidence boundaries.

### 3.3 Files and directories

- Directories and non-component source files use lowercase `kebab-case`.
- React component files use `PascalCase.tsx` and export the same component name.
- Hooks use `use<Name>.ts` and export `use<Name>`.
- Unit/integration tests use `<subject>.test.ts` or `<subject>.test.tsx`.
- Browser end-to-end tests use `<subject>.spec.ts`.
- Existing monitor/checker tests remain `.test.mjs`; do not rename them merely
  to match new application tests.
- SQL migrations use a zero-padded sequence and kebab-case description, for
  example `001-initial.sql`. A merged migration is immutable; corrections use a
  new migration.
- JSON fixture filenames use lowercase kebab-case. Human-review streams use
  `.jsonl` when records are append-only.
- Avoid catch-all names such as `utils.ts`, `helpers.ts`, `common.ts`, or
  `types.ts` outside the explicitly named adapter common directory. Name a file
  for the domain responsibility it owns.

### 3.4 Events, logs, and metrics

- New v2 event names use lower-case dot notation: `<domain>.<action>`, for
  example `stage.started`, `model.attempted`, `retry.scheduled`,
  `effect.verified`, and `claim.emitted`.
- Event values MUST come from the F02 event registry. Producers MUST NOT scatter
  string literals or create synonyms such as both `run.finished` and
  `run.completed`.
- Existing monitor-v1 event values remain unchanged and are translated only by
  an explicit compatibility reader.
- Log field names match contract field names. Logs MUST include correlation
  identity and MUST NOT include credentials, raw private content, full MIME,
  model private reasoning, or unredacted provider payloads.
- Product metrics retain the names `M1` through `M7`. A display label may explain
  a metric but MUST NOT rename or recompute it.
- Counters use countable plural nouns. Durations end in `Ms`; byte counts end in
  `Bytes`; timestamps end in `At`.

## 4. Canonical repository structure

The following tree is the canonical target. A commit creates only the paths in
its allowed-path list; this tree does not grant permission to edit another
owner's files.

```text
.
├── docs/
│   ├── demo-runbook.md
│   ├── evaluation-summary.md
│   ├── reliability-brief.md
│   └── release-manifest.json
├── ideation/
│   └── implementation-plan/
├── src/
│   ├── shared/
│   │   ├── adapters.ts
│   │   ├── agents.ts
│   │   ├── api.ts
│   │   ├── checker.d.ts
│   │   ├── domain.ts
│   │   ├── errors.ts
│   │   ├── evaluation.ts
│   │   ├── events.ts
│   │   └── reliability.ts
│   ├── server/
│   │   ├── adapters/
│   │   │   ├── common/
│   │   │   │   ├── errors.ts
│   │   │   │   ├── pagination.ts
│   │   │   │   └── transport.ts
│   │   │   ├── github.ts
│   │   │   ├── gmail-mime.ts
│   │   │   ├── gmail.ts
│   │   │   ├── hubspot.ts
│   │   │   └── slack.ts
│   │   ├── agents/
│   │   │   ├── analyst/{index,prompt,validate}.ts
│   │   │   ├── auditor/{index,prompt,validate}.ts
│   │   │   ├── drafter/{index,prompt,validate}.ts
│   │   │   ├── model.ts
│   │   │   └── runtime.ts
│   │   ├── api/{auth,health,runs}.ts
│   │   ├── evaluations/
│   │   │   ├── collector.ts
│   │   │   ├── export-checker.ts
│   │   │   ├── harness.ts
│   │   │   ├── labels.ts
│   │   │   ├── manifest.ts
│   │   │   ├── metrics.ts
│   │   │   ├── provider-readers.ts
│   │   │   └── report.ts
│   │   ├── execution/{claim,executor,ordering,reconcile,recovery}.ts
│   │   ├── migrations/001-initial.sql
│   │   ├── monitoring/
│   │   │   ├── assess.ts
│   │   │   ├── claim-verdicts.ts
│   │   │   ├── demo.ts
│   │   │   ├── sweeper.ts
│   │   │   ├── trace-rules.ts
│   │   │   └── worker.ts
│   │   ├── observability/{events,export-worker,langsmith,redaction}.ts
│   │   ├── policy/
│   │   │   ├── approval.ts
│   │   │   ├── canonical.ts
│   │   │   ├── claims.ts
│   │   │   ├── effect-keys.ts
│   │   │   ├── freshness.ts
│   │   │   ├── identity.ts
│   │   │   ├── incident.ts
│   │   │   ├── plan.ts
│   │   │   └── selection.ts
│   │   ├── storage/
│   │   │   ├── checkpoints.ts
│   │   │   ├── database.ts
│   │   │   ├── monitor-store.ts
│   │   │   └── repositories.ts
│   │   ├── verification/{assertions,finalize,readback}.ts
│   │   ├── workflow/
│   │   │   ├── approval-wait.ts
│   │   │   ├── driver.ts
│   │   │   ├── graph.ts
│   │   │   ├── nodes.ts
│   │   │   ├── recovery-node.ts
│   │   │   ├── review.ts
│   │   │   └── state.ts
│   │   ├── app.ts
│   │   ├── composition.ts
│   │   ├── config.ts
│   │   └── index.ts
│   └── web/
│       ├── api/client.ts
│       ├── components/
│       ├── fixtures/demo.ts
│       ├── hooks/useRun.ts
│       ├── App.tsx
│       ├── main.tsx
│       └── styles.css
├── tests/
│   ├── adapters/
│   ├── app/
│   ├── e2e/
│   ├── fakes/
│   ├── fixtures/
│   ├── monitoring/
│   ├── reliability/
│   └── scenarios/
└── tools/
    ├── demo/
    ├── evaluations/
    ├── fixtures/
    ├── monitoring/
    ├── reliability/
    └── smoke/
```

These conflict resolutions are explicit:

- Use `src/server/policy/`, singular. Do not create `policies/`.
- Use `src/server/composition.ts`. Do not create
  `src/server/workflow/composition.ts`.
- Put independent provider collection in `src/server/evaluations/`. Do not
  create a parallel `src/server/collectors/` tree.
- Put SQL migrations in `src/server/migrations/`. Do not create a second
  migrations directory under storage.
- New application tests follow the exact `tests/app/`, `tests/adapters/`,
  `tests/scenarios/`, and `tests/e2e/` paths in commit briefs. Do not create
  alternate `tests/policies/`, `tests/storage/`, or `tests/workflow/` trees for
  the same planned work.
- `src/shared/` contains cross-lane serializable contracts only. Runtime clients,
  environment access, database handles, framework objects, and provider SDK
  objects stay in `src/server/`.

## 5. Branch and commit naming

### 5.1 Branch names

Branch names use `<type>/<kebab-case-purpose>`. The planned mapping is fixed:

| Branch | Commit ID(s) | Required/optional |
| --- | --- | --- |
| `chore/monitor-baseline` | P00 | required baseline |
| `feat/foundation` | F01, F02 | required, sequential |
| `feat/durable-core` | B01 | required |
| `feat/selection-policy` | B02 | required |
| `feat/plan-policy` | B03 | required |
| `feat/workflow-driver` | B04 | required |
| `feat/slack-approval` | B05 | required |
| `feat/guarded-execution` | B06 | required |
| `feat/readback-verifier` | B07 | required |
| `feat/durable-recovery` | B08 | optional |
| `feat/adapter-core` | I01 | required |
| `feat/github-adapter` | I02 | required |
| `feat/hubspot-adapter` | I03 | required |
| `feat/slack-adapter` | I04 | required |
| `feat/gmail-adapter` | I05 | required |
| `feat/agent-runtime` | A01 | required |
| `feat/agent-analyst` | A02 | required |
| `feat/agent-drafter` | A03 | required |
| `feat/agent-auditor` | A04 | required |
| `feat/operator-console` | U01, U02 | required, sequential |
| `feat/evaluation-view` | U03 | optional |
| `feat/evaluation-fixtures` | Q01 | required |
| `feat/evidence-collector` | Q02 | required |
| `feat/reliability-monitor` | Q03 | required |
| `feat/scenario-harness` | Q04 | required |
| `feat/evaluation-metrics` | Q05 | required |
| `feat/langsmith-export` | Q06 | optional |
| `feat/workflow-integration` | R01 | required |
| `chore/demo-release` | R02 | required |

Do not add person names, dates, ticket systems, `wip`, or version suffixes to
these branch names. If a post-merge correction is required, use
`fix/<commit-id>-<kebab-case-purpose>` and identify the affected implementation
ID in the handoff.

### 5.2 Commit IDs

- IDs match `^(P00|F0[1-2]|B0[1-8]|I0[1-5]|A0[1-4]|U0[1-3]|Q0[1-6]|R0[1-2])$`.
- Families mean: `P` preservation, `F` foundation, `B` backend/control plane,
  `I` external-app integration, `A` agent/model, `U` operator UI, `Q`
  quality/evaluation, and `R` integration/release.
- One ID maps to one reviewed commit SHA. Never reuse an ID or combine two IDs
  into one commit.
- `feat/foundation` MUST retain separate F01 and F02 commits.
  `feat/operator-console` MUST retain separate U01 and U02 commits.
- A branch may contain temporary local fixups, but before handoff its history
  MUST make each planned ID an independently reviewable commit. Do not squash
  across planned IDs.

### 5.3 Commit subjects

Canonical subject format:

```text
<type>(<area>): [<ID>] <imperative summary>
```

Example:

```text
feat(foundation): [F02] freeze shared application contracts
```

Allowed types are `feat`, `fix`, `test`, `docs`, `chore`, and `refactor`.
Areas use lowercase kebab-case and describe the owned module, not the person.
The ID appears exactly once. Keep the subject imperative, lower-case after the
ID, at most 72 characters where practical, and without a trailing period.

The mixed ID placement in older suggested-subject examples is legacy planning
text. This section wins for commits created after this convention is adopted;
do not rewrite an already reviewed SHA solely to normalize its subject.

Commit bodies SHOULD contain:

```text
Prerequisites: F02@<sha>, B01@<sha>
Evidence mode: synthetic | mock | live
Tests: <commands and result>
Handoff: <consumer IDs>
```

## 6. Ownership and dependency rules

### 6.1 Exclusive owners

- **P1:** root package/lock/config files, `src/shared/*`, migrations, API mounts,
  `src/server/app.ts`, `src/server/index.ts`, `src/server/composition.ts`, and
  final graph topology.
- **P2:** `src/server/adapters/*`, provider smoke tools, and adapter tests.
- **P3:** `src/server/agents/*`, `src/server/policy/*`, and
  `src/server/verification/*`.
- **P4:** `src/server/evaluations/*`, assessment logic under
  `src/server/monitoring/*`, `src/web/*`, scenario truth, fakes, labels, metrics,
  and demo evidence.

The individual commit brief narrows these broad lanes. A broad lane does not
grant permission outside that commit's allowed paths. B01's reviewed
transaction-boundary work in `monitor-store.ts` is the named exception to the
otherwise preserved monitor baseline.

### 6.2 Shared-file protocol

1. One active owner edits a hotspot.
2. A consumer requests a shared change from the owner; it does not create a
   local shadow type or edit the hotspot concurrently.
3. The owner adds or changes the contract, accepted/rejected examples, and
   compatibility tests in one reviewed change.
4. Consumers rebase or merge the exact prerequisite SHA, delete temporary
   shims, and run their focused checks.
5. The handoff records every affected consumer.

Hotspots include root manifests, `src/shared/*`, migrations,
`src/server/composition.ts`, `src/server/workflow/graph.ts`, API mounts,
`src/web/App.tsx`, joined styles, and frozen scenario manifests.

### 6.3 Dependency semantics

- Hard gates are commit IDs and reviewed SHAs, not branch names.
- Work MAY be drafted against a frozen contract before another implementation
  lands. It MUST NOT merge until every hard prerequisite in its commit brief is
  on the target branch.
- Merge one branch or planned commit at a time, validate the integrated target,
  record its SHA, then release downstream merges.
- A soft input, fixture, or review dependency MUST be labeled as such; it cannot
  be described as a hard gate in another file without updating both plans.
- Optional B08, U03, and Q06 become R02 hard gates only when the release manifest
  includes their capability. Otherwise they remain explicitly deferred.

## 7. Shared contract and schema rules

### 7.1 Runtime validation

- F02 schemas are the single source of truth for shared runtime data. Infer or
  derive TypeScript types from those schemas; do not maintain hand-written
  interfaces with the same shape in another lane.
- Validate at every trust boundary: environment input, HTTP input, provider
  response, model output, persisted-version read, fixture ingest, and imported
  evidence.
- Internal code MAY operate on validated domain values. It MUST NOT cast unknown
  input into a shared type to bypass validation.
- Public objects include `schemaVersion`. Producers write one version; readers
  either accept it explicitly or fail with an unsupported-version error.
- Breaking changes require a new schema version and compatibility reader.
  Existing monitor-v1/checker-v1 persisted input MUST NOT change meaning.

### 7.2 Field representation

- JSON and TypeScript use `camelCase`; SQLite columns use `snake_case`.
- Timestamps are UTC RFC 3339 strings and end in `At`. Persist the original
  provider timestamp separately from collection time when both matter.
- Durations are non-negative integer milliseconds and end in `Ms`.
- Digests use `sha256:<64 lowercase hexadecimal characters>`.
- IDs are opaque branded strings. Never parse business meaning from an ID or
  substitute a display name/URL for an immutable provider ID.
- Missing and `null` have different meanings. Omit a field only when the schema
  declares it optional; use an explicit state/reason when evidence is
  unavailable.
- Arrays with semantic order preserve it. Sets used for hashing are normalized
  and sorted by stable ID before canonical serialization.
- Unknown provider fields MAY be retained in a redacted raw receipt, but MUST
  NOT be copied into approved expectations or trusted provenance.

### 7.3 Canonical identity vocabulary

Use these names exactly:

| Field/type | Scope |
| --- | --- |
| `runId` / `RunId` | one logical PromiseGuard workflow record |
| `runtimeAttemptId` / `RuntimeAttemptId` | one runtime execution attempt |
| `evaluationAttemptId` / `EvaluationAttemptId` | one registered evaluation attempt and denominator member |
| `roleInvocationKey` / `RoleInvocationKey` | stable identity of `(runId, planRevision, role)` |
| `modelAttemptId` / `ModelAttemptId` | one model dispatch, new for a permitted retry |
| `logicalCallId` / `LogicalCallId` | one logical provider operation across reconciliation/retry handling |
| `providerAttemptId` / `ProviderAttemptId` | one provider dispatch |
| `planRevision` / `PlanRevision` | immutable revision of one run's plan |
| `claimId` / `ClaimId` | one externally meaningful success assertion |
| `effectKey` / `EffectKey` | stable identity of one logical external effect |
| `suiteEntryId` / `SuiteEntryId` | one frozen scenario-census entry |
| `EffectIdRef` | typed placeholder for an ID unavailable before creation |
| `ApprovedContentRef` | typed reference to exact content frozen before dispatch |

Legacy `attemptId` is accepted only by the versioned compatibility reader and
maps to `runtimeAttemptId`. A payload containing both with different values is
rejected. A model or provider attempt ID MUST NOT be used as a runtime attempt
ID.

### 7.4 Canonical serialization and hashes

Plan, content, manifest, and effect hashes MUST use one shared canonicalizer
owned by B03/F02:

1. validate the typed object;
2. normalize strings to UTF-8 NFC and line endings to LF;
3. preserve `null` and reject `undefined` in hash-bearing data;
4. sort object keys recursively;
5. sort set-like arrays by stable ID while preserving order-sensitive arrays;
6. serialize without insignificant whitespace; and
7. hash the resulting bytes with SHA-256.

Never build security- or idempotency-sensitive hashes by concatenating fields
with a delimiter. Hash inputs MUST carry a schema/policy version so a
canonicalization change cannot silently preserve authority.

`effectKey` is derived only from the frozen logical identity:

```text
incidentFingerprint + app + stableBusinessTargetId + actionType
```

It excludes plan revision, runtime/model/provider attempts, and destination IDs
created by the provider. `approvalHash` covers the complete immutable plan,
including source versions, selected IDs, policy version, exact recipients,
subject/body bytes, owners, due dates, and all effect payloads.

The canonical stored plan digest is `planHash`. `approvalHash` MUST equal that
same full `planHash`; it is not a second derivation. Slack may display the first
eight hexadecimal digest characters only when they uniquely identify one active
plan in the configured approval scope. Storage, approval validation, and
execution always compare the full digest.

### 7.5 Standard result semantics

Network, model, and collection results use discriminated unions. Do not return
`null`, an empty array, or `ok: true` for multiple meanings.

```typescript
type CompleteResult<T> = {
  status: "complete";
  value: T;
  receipt: ObservationReceipt;
};

type IncompleteResult<T> = {
  status: "incomplete";
  partialValue?: T;
  reason: IncompleteReason;
  receipt: ObservationReceipt;
};

type FailedResult = {
  status: "failed";
  error: NormalizedError;
  receipt?: ObservationReceipt;
};

type UnknownWriteResult = {
  status: "unknown";
  logicalCallId: LogicalCallId;
  providerAttemptId: ProviderAttemptId;
  reconciliationRequired: true;
};
```

A page-limit, time-limit, denied page, malformed response, or missing required
scope is `incomplete` or `failed`, never a complete empty result.

F02 owns one `NormalizedErrorCode` registry in `src/shared/errors.ts`. New
producers MUST use these lower-snake-case codes and MUST NOT expose provider
messages as public codes:

```typescript
type NormalizedErrorCode =
  | "invalid_input"
  | "unsupported_schema_version"
  | "invalid_configuration"
  | "auth_denied"
  | "permission_denied"
  | "rate_limited"
  | "timed_out"
  | "budget_exhausted"
  | "incomplete_read"
  | "malformed_response"
  | "not_found"
  | "conflict"
  | "provider_rejected"
  | "unknown_write_outcome"
  | "persistence_failed"
  | "lease_lost"
  | "stale_source"
  | "approval_invalid"
  | "approval_expired"
  | "verification_failed"
  | "unsupported_transport"
  | "internal_error";

type NormalizedError = {
  schemaVersion: string;
  code: NormalizedErrorCode;
  message: string;
  retryable: boolean;
  retryOwner: "none" | "transport" | "workflow" | "operator";
  providerCode?: string;
  retryAfterMs?: number;
  restrictedReceiptRef?: string;
};
```

`message` is sanitized for operators. Raw provider bodies, stack traces, and
causes remain in restricted receipts. Adding or changing a code requires an F02
schema-version change and consumer tests.

## 8. Domain vocabulary and state machines

### 8.1 Agent contracts

The three role names, exported functions, and outputs are fixed:

| Role | Function | Output |
| --- | --- | --- |
| `analyst` | `analyzeIncident(...)` | `AgentCallResult<IncidentAssessment>` |
| `drafter` | `draftCustomerUpdate(...)` | `AgentCallResult<DraftProposal>` |
| `auditor` | `auditSemantics(...)` | `AgentCallResult<AuditFindings>` |

- A01 owns `createModelClient(...)` and `invokeRole(...)`.
- Only R01 workflow nodes invoke the three role functions.
- A role directory exports its public function from `index.ts`; prompt and
  output validation stay in `prompt.ts` and `validate.ts`.
- The auditor receives original source evidence, proposed text, claim
  references, and the task contract. It does not receive analyst/drafter
  reasoning, confidence, expected verdict, or shared conversation history.
- A model result can advise or block progression through policy. It never grants
  approval or authorizes a provider mutation.

### 8.2 Workflow stages

Stable stage IDs are:

```text
ingest -> select -> analyze -> draft -> audit -> approve -> execute -> verify -> assess
```

Deterministic checks and plan freezing occur at their documented boundaries but
are not presented as extra agents. A complete empty selection branches after
`select` to absence verification and assessment; it skips analyze, draft, audit,
approve, execute, and final Slack summary.

That branch is legal only when the source read is `complete`, its account/query/
horizon scope matches the frozen policy, deterministic selection returns zero
eligible `commitmentId` values, and B07/Q02 independently establish the required
absence and protected-record predicates. Its claim uses `scope: "no_affected"`,
omits `planRef` and approval references, and records the source, policy, empty-
selection, and absence-evidence receipts. Any incomplete or ambiguous predicate
blocks completion.

### 8.3 Separate state vocabularies

Do not reuse one generic `status` union across unrelated entities.

```typescript
type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "executing"
  | "safely_blocked"
  | "failed"
  | "failed_partial"
  | "completed"
  | "completed_no_affected_commitments";

type StageStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped";

type EffectStatus =
  | "planned"
  | "intent_persisted"
  | "dispatching"
  | "unknown"
  | "applied"
  | "verified"
  | "failed";

type ClaimVerdict = "confirmed" | "contradicted" | "unverified";
type ReportAvailability = "pending" | "available" | "unavailable";
```

`waiting`, `paused`, `partial`, `blocked`, `stalled`, `exhausted`, and
`verified_completed` are not alternate `RunStatus` values. Represent their
meaning through the appropriate stage/effect status, durable retry metadata,
or the canonical run value. Compatibility readers may map old values, but new
producers use only the canonical vocabulary above.

`completed` means all required artifact readbacks and the final Slack summary
readback succeeded. A run with unresolved, missing, stale, or contradicted
evidence cannot be `completed`.

### 8.4 Effect state transitions

The legal forward transitions are:

```text
planned -> intent_persisted -> dispatching -> applied -> verified
                                |            `-> failed (readback mismatch)
                                |-> failed (definitive provider rejection)
                                `-> unknown -> applied (conclusive reconciliation)
                                            `-> failed (conclusive nonapplication)
```

`unknown` remains unresolved when bounded reconciliation cannot prove exactly
one approved effect or definitive nonapplication. It MUST retain its claim,
block later writes, and make the run `failed_partial`; it MUST NOT transition
back to `planned` or `dispatching`. `verified` is terminal. State history is
append-only, so a later verification failure does not erase evidence that the
provider previously acknowledged or applied an effect.

### 8.5 Protected artifact order

For each selected commitment, execute and verify in this order:

1. create and read back the HubSpot task;
2. create and read back the HubSpot note;
3. create and read back the Gmail draft;
4. create and read back the marked GitHub comment; and
5. after required effects are verified, publish and read back the final Slack
   thread summary.

Before every remaining mutation, B06 revalidates the approval reference,
expiry, source freshness, immutable plan hash, and effect state. Provider
operations for one run MUST NOT be parallelized.

### 8.6 Approval grammar

- Approval and rejection are human Slack decisions observed through I04 and
  validated only by B05.
- A decision references `runId` and an unambiguous approval-hash prefix.
- B05 validates actor allowlist/type, workspace, channel, thread, message,
  current unedited content, revision/hash, rejection history, observation time,
  expiry, and complete fresh source state.
- Rejection is final for that plan revision.
- B05 returns a server-owned `ApprovalReference`; B06 revalidates that reference
  before each mutation.
- The browser has no approve endpoint or client-supplied approval field.

## 9. Adapter and external-app contracts

### 9.1 Boundary shape

- F02 owns narrow reader, coordinator, and mutation interfaces.
- I01 owns bounded transport, pagination, normalized errors, budgets, clocks,
  receipts, and provider-attempt identity.
- I02-I05 implement provider details without importing graph or UI code.
- Reader and writer capabilities are separate interfaces. No generic
  `request()`, arbitrary URL, generic tool registry, or caller-selected HTTP
  method crosses the shared boundary.
- Read-only retries have one bounded owner. Mutation transport retries are off;
  uncertain writes return `unknown` for B06 reconciliation.
- Every paginated read reports scope, pages visited, bounds, and completeness.
- Every provider call receives injected account scope, clock, budget, and
  transport. Adapters do not read process environment directly.

An operation budget is cumulative across pagination and retries. It contains an
absolute deadline plus maximum page, record, and response-byte counts. Each page
uses only the remaining budget; page requests and retry delays never reset or
multiply it. Stop at the first denied, malformed, failed, or over-budget page,
retain already observed pages in the restricted receipt, and return
`incomplete`. Do not continue later pages and do not reinterpret a partial empty
page as a complete empty result.

### 9.2 Provider capability allowlist

- GitHub: read incident evidence and marked comments; create/read the exact
  approved marked impact comment. No issue closure, merge, code write, or
  arbitrary URL crawl.
- HubSpot: read commitments, companies, owners, designated contacts, tasks,
  notes, and typed associations; create/read approved tasks and notes. No
  update/delete or ambiguous association choice.
- Slack: publish/find/read the review thread, read complete replies and actor/edit
  metadata, and publish/read the final summary. Slack transport never decides
  whether a reply is valid approval.
- Gmail: create a base64url MIME draft and list/read the complete draft including
  To/Cc/Bcc, subject, body, and draft state. No send/update/delete.

### 9.3 Modes

- `PG_ADAPTER_MODE` is `fake` or `rest` for the required release.
- `mcp` is accepted only after an explicit optional implementation provides a
  reviewed operation binding and the same conformance/readback behavior. An
  unsupported `mcp` value fails startup.
- There is no silent fallback between fake, REST, and MCP, especially after an
  uncertain write.
- Transport mode is frozen for a run and included in its configuration receipt.
- MCP tool names, when implemented, use `<provider>.<resource>.<verb>` and map
  one-to-one to an existing narrow adapter operation. MCP cannot add authority.
- If configured `mcp` capability discovery, schema validation, authentication,
  or startup health fails, startup fails explicitly. Runtime MUST NOT substitute
  REST or fake transport for that run.

## 10. Persistence and transaction conventions

- SQLite table and column names use plural `snake_case` table names and singular
  `snake_case` columns.
- Primary keys end in `_id`; foreign keys use the referenced singular entity
  name plus `_id`; timestamps end in `_at`; digests end in `_digest`.
- Boolean values use `is_`/`has_` prefixes and are constrained to `0` or `1`.
- Enum columns are constrained to the F02 lower-snake-case values.
- Foreign keys are enabled. Required uniqueness includes stable event IDs,
  `claim_id`, and the logical effect identity needed to prevent duplicate
  creates.
- Persist JSON only for versioned immutable payloads or receipts whose complete
  structured shape is preserved. Query-critical identity, state, ordering, and
  timestamps remain typed columns.
- Store provider-created IDs separately from `effect_key`; do not replace the
  logical identity after dispatch.
- Corrections append a new row with reason and `supersedes_id`; they do not
  update or delete original model/evidence/label records.
- Graph checkpoints coordinate resumption but are not authoritative proof that
  an external effect was applied.

B01 MUST commit the application state transition, canonical event, and
measurement job atomically on the same SQLite connection. A post-commit append
to a separate monitor database does not satisfy durability. A failure before
intent persistence prevents dispatch; a crash after dispatch leaves an explicit
unknown outcome for reconciliation.

Measurement jobs use states `ready`, `leased`, `completed`, and `exhausted`.
Lease duration, retry limit, and bounded backoff are validated configuration and
are copied into the run/evaluation receipt; implementations MUST NOT hide
different local constants. A lease has an opaque token and expiry. Only the
current unexpired token may complete or reschedule its job, expiry is the only
automatic path from `leased` back to eligibility, and a stale worker cannot
overwrite a newer lease. Every failed attempt increments the durable count;
exhaustion remains visible and produces unavailable/unverified assessment rather
than disappearing from a denominator.

## 11. API and frontend conventions

### 11.1 HTTP API

- The API base is `/api`; resources use plural nouns.
- The minimum run surface is `POST /api/runs`, `GET /api/runs/:runId`, and a
  cursor-paginated run-event read owned by B04/F02.
- Commands return durable command identity and the current run revision. They do
  not accept client-supplied terminal status, approval, observations, labels,
  evidence provenance, or metric values.
- Cursor values are opaque. Clients MUST NOT parse or manufacture them.
- Mutating browser commands require authenticated operator access and CSRF
  protection. Provider/model credentials are server-only.
- API errors are structured, versioned, machine-readable, and include a stable
  error code. Stack traces and private provider payloads are not public fields.
- Use HTTP status for transport semantics and a typed domain result for business
  semantics. An HTTP 2xx response does not imply provider effect verification.

### 11.2 Browser boundary

- F02 owns `RunView`, `RunEventsPage`, command result/error,
  `AssessmentSummaryView`, and optional `EvaluationSummaryView`.
- B04 produces those projections; U02 consumes them without redefining them.
- The browser renders server-supplied counts and verdicts. It performs no
  approval validation, completion inference, claim verification, or M1-M7
  arithmetic.
- UI components use the stable stage and state vocabularies in this document.
  Text and icon/shape must both communicate pending, failed, partial,
  unverified, unavailable, and completed states.
- `0/0` metrics render as unavailable/N/A with their raw numerator and
  denominator; they never render as 0% or 100%.
- Synthetic fixtures are visibly identified. Missing server evidence remains
  unavailable rather than being replaced with fixture data.
- Polling uses one in-flight request, cursor deduplication, and run-revision
  protection. A stale response cannot overwrite a newer projection.

## 12. Evaluation and evidence conventions

### 12.1 Required separation

Persist and report these dimensions independently:

1. original AI proposal quality, using immutable first outputs and independent
   human labels;
2. runtime/process correctness, using canonical events, attempts, guards,
   retries, and claim timing; and
3. outcome correctness, using independently collected expected-versus-observed
   provider state.

Passing one dimension cannot supply evidence for another. The existing checker
and monitor-v1 remain valid for their stated scope but cannot prove live model
quality or live four-app effects.

### 12.2 Provenance fields

Evidence records MUST bind at least:

- account and query scope;
- collector identity and version;
- request/page references and completeness;
- collection start/end timestamps;
- raw and normalized digests;
- `runId`, relevant attempt IDs, plan revision, and claim/effect references;
- model mode and adapter mode as separate fields; and
- trusted ingestion origin separately from caller-supplied mode text.

Use explicit values such as `synthetic_fixture`, `fake_provider`,
`live_model`, `live_provider`, and `human_review` only for the dimension they
describe. Do not compress them into a single misleading `live: true` flag.

### 12.3 Fixtures, labels, and metrics

- Q01 owns the immutable suite census, source facts, semantic invariants,
  forbidden effects, logical expectations, and stateful fakes.
- Expected semantic values are frozen before execution. Future provider IDs use
  `EffectIdRef`; expected content uses `ApprovedContentRef`; neither is copied
  from observed provider state.
- Q02 owns independent S0/S1 collection with separate read-only clients. Cached
  executor responses are not evidence.
- Q02 MAY reuse I01 transport, pagination, parsing, and normalized-error code.
  It MUST create a separate read-only client invocation with its own
  `collectionId`, observation IDs, account/query scope, budget, timestamps,
  attempt IDs, retries, receipts, and raw-response digests. It MUST NOT reuse a
  B06/B07 request, cache, budget token, receipt, or success verdict as an
  observation.
- Q03 owns claim verdict calculation. Q05 consumes persisted verdicts and does
  not recompute claim truth.
- Q05 labels bind reviewer identity/kind, timestamp, source/output digests,
  claim-level verdict/reason, uncertainty, and optional `supersedes` reference.
- A model-generated or fixture-generated label MUST NOT claim `human_review`.
- Metric outputs include raw numerator, denominator, eligible/attempted census,
  mode, versions, cutoff/watermark, gaps, and underlying attempt/claim IDs.
- Setup failures, attempted failures, unrun entries, and missing labels remain
  separate. Resume/replay/correction does not silently increase a frozen
  denominator.
- `falseCompletion` is a deduplicated union by `claimId`; a claim appearing in
  more than one violation class is counted once in that aggregate.

## 13. Configuration and secrets

- F01 owns environment parsing in `src/server/config.ts`. Other modules receive
  validated configuration through dependency injection and MUST NOT call
  `process.env` directly.
- `PG_MODEL_MODE=mock|live` and `PG_ADAPTER_MODE=fake|rest` are independent.
- `OPENAI_API_KEY`, `OPENAI_MODEL`, optional role-model overrides, model budgets,
  and provider credentials are server-only.
- Browser-visible environment variables MUST NOT contain credentials, tokens,
  account secrets, private evidence, or provider payloads.
- `.env.example` contains names and safe descriptions/placeholders only.
- Missing credentials in a selected live mode fail explicitly before dispatch.
  They are recorded as failed or unrun, never silently replaced by mock/fake.
- Credentials, OAuth refresh tokens, real account IDs, raw MIME, private source
  snapshots, databases, receipts with private content, `dist`, and
  `node_modules` MUST NOT be committed.
- Use least-privilege provider scopes and disposable test records. Tests sharing
  a mailbox, Slack thread, HubSpot namespace, or GitHub issue run sequentially.

## 14. Test and validation conventions

### 14.1 Test ownership and locations

- Preserve Node ESM monitor/checker tests under `tests/monitoring/` and
  `tests/reliability/`.
- New application contract and feature tests use `tests/app/`.
- Adapter conformance tests use `tests/adapters/`.
- End-to-end workflow/fault/recovery tests use `tests/scenarios/`.
- Browser automation uses `tests/e2e/`; React component tests use the exact path
  assigned by U01-U03 briefs.
- Shared deterministic fixtures live in `tests/fixtures/`; stateful provider and
  model fakes live in `tests/fakes/`.
- Live smoke tools live in `tools/smoke/` and are never part of the default
  deterministic test command.

### 14.2 Test naming and behavior

- Test descriptions state behavior and expected outcome, not implementation
  trivia: `blocks when page two is unavailable`.
- Inject clocks, random/ID sources, transports, model clients, and provider
  clients. Unit tests MUST NOT depend on wall-clock time or live networks.
- Each boundary includes positive, malformed, incomplete, stale, duplicate,
  unauthorized, timeout, unknown-outcome, and persistence-failure cases as
  applicable.
- A fixture test is labeled synthetic; a model smoke proves only the tested
  model/schema transport; a provider smoke proves only that provider operation;
  neither is described as end-to-end proof.
- Missing live credentials produce an explicit unrun/failure result and a
  non-success release gate. They do not make a test pass.

### 14.3 Validation order

Each implementation commit runs, in order:

1. the narrow test for the touched behavior;
2. the owning package/type check;
3. the relevant domain suite;
4. existing monitor/checker regressions when a shared, storage, event,
   evaluation, or root configuration boundary changed;
5. build and integration checks required by the commit brief; and
6. separately labeled live smoke checks when that commit owns live access.

Record commands, pass/fail/unrun counts, environment/mode, and evidence location.
A statement such as “tests pass” without the command and scope is not a receipt.

## 15. Handoff and merge schema

Every planned commit supplies this record before merge:

```yaml
implementationId: F02
conventionsVersion: "1.1"
branch: feat/foundation
owner: P1
baseSha: <full-sha>
commitSha: <full-sha>
prerequisites:
  - id: F01
    sha: <full-sha>
schemaVersions:
  shared: <version-or-not-applicable>
modes:
  model: mock | live | not-applicable
  adapter: fake | rest | mcp | not-applicable
allowedPaths:
  - src/shared/**
tests:
  - command: npm run test:app -- contracts
    result: passed | failed | unrun
    counts: <summary>
evidence:
  - kind: synthetic | model-live | provider-live | human-review
    location: <sanitized-path-or-receipt-reference>
knownGaps:
  - <explicit gap or none>
consumers:
  - B01
reviewers:
  - lane: P2
    status: accepted | changes-requested | pending
```

Rules:

- Use full Git SHAs in receipts; short SHAs are display-only.
- `allowedPaths` is copied from the commit brief and compared with the actual
  diff. Every out-of-scope file requires owner approval and a documented reason.
- Failed and unrun checks stay in the record. Do not delete them when another
  check passes.
- Public evidence references are sanitized and reproducible. Private raw
  receipts remain outside Git and are referenced by digest when needed.
- Update the commit-ID-to-SHA register and Global Scale only after review.
- The receiving owner explicitly accepts the handoff before the dependent merge.

## 16. Definition of done

A branch or commit is complete only when all applicable conditions hold:

- exact hard-prerequisite SHAs are on the target branch;
- the diff is limited to allowed paths or approved exceptions;
- shared imports use the frozen F02 contracts with no local duplicate schemas;
- all owned positive and negative behavior is implemented;
- focused tests, typecheck, build, and required regressions pass;
- live checks are honestly classified as passed, failed, or unrun;
- no secret/private/build/database artifact is tracked;
- schema/event/config versions and evidence modes are recorded;
- first outputs and evidence remain immutable and traceable;
- the handoff is accepted by named consumers;
- the implementation ID maps to one reviewed SHA; and
- Global Scale reflects observed evidence, not intended behavior.

R02 additionally requires R01, U02, Q04, and Q05. It MUST freeze the exact code,
dependency, runtime, model, prompt, policy, schema, evaluator, fixture, source,
suite-census, mode, optional-capability, and report-cutoff versions used for the
release. No capability may be described as implemented, live, verified, or
human-reviewed without matching evidence.

## 17. Change control

- Fix a convention conflict here before parallel branches encode different
  answers.
- A naming-only change is reviewed by every affected path owner.
- A shared payload or state change requires an F02-owned schema version change,
  accepted/rejected examples, compatibility behavior, and consumer tests.
- A persistence change requires a new migration and old-data test.
- An approval, effect-key, ordering, retry, reconciliation, verification,
  evidence-provenance, or completion change requires P1 and P4 review because it
  can change both safety and reported metrics.
- Update links, branch/commit briefs, and the merge runbook in the same reviewed
  change when their instructions would otherwise become contradictory.
- Never repair divergence with undocumented aliases. Migrate once at a named
  boundary, reject conflicts, and remove temporary compatibility code when its
  stated window closes.