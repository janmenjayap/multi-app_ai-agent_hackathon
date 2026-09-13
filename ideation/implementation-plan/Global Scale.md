# Global Scale: implementation and completion verification

**Current verdict — September 14, 2026 (IST): planning, the verified offline
checker, and a partial standalone reliability monitor; the PromiseGuard
application is not implemented.** This file compares the intended system with
observed repository evidence. It is the global completion checklist for the
[commit plan](04-commit-plan.md), not a claim of production readiness or a
percentage of work completed.

**Delivery navigation:** [per-branch plans](branches/README.md) and
[individual commit briefs](commits/README.md) now specify the remaining work,
parallel subtasks, merge gates, and evidence handoffs. They preserve the original
30 implementation IDs and add P00 to capture the tested monitor baseline. Their
unchecked Git SHA/completion fields are future execution records; creating these
documents does not advance any application capability or verification gate.
The [agent reliability completion plan](06-agent-reliability-implementation.md)
now adds the audit's remaining work to those same IDs: original proposal review,
real runtime controls/traces, independently collected expected/actual state,
versioned completion-claim evaluation and complete scenario census.

**Historical audit checkpoint:** September 13, 2026, 18:23:28 UTC / 23:53:28 IST.
**Scope:** GitHub + HubSpot + Slack + Gmail, with Evidence Analyst, Customer Update
Drafter, and Blind Semantic Auditor. Selection, approval, execution, and final
verification remain deterministic code. Read the [canonical demo contract](../demo-scenarios-and-reliability.md),
[architecture](../promiseguard-architecture.md), [selected proposal](../final-project-promiseguard.md),
and [event requirements](../requirements-and-timeline.md) before changing acceptance
criteria. The [contracts](05-contracts-and-handoffs.md) define branch handoffs.

## LLM and app integration planning update — September 14, 2026

The [LLM guide](07-agent-spawning-and-llm-integration.md) and
[external-app guide](08-mcp-api-and-external-app-integration.md) now assign exact
call sites, configuration, contracts, app methods and tests to the existing
commit/branch plans. This is a documentation update: no model/provider call,
account setup, implementation commit or new passing result is recorded here.

For C05–C07, require actual A01-backed analyst/drafter/auditor output/attempt
receipts and R01 graph-order/resume proof. For C08–C11, require I02–I05 live REST
smokes plus B05 approval, B06 guarded effects and B07 independent reads. Q02/C13
must collect its own provider evidence; C14 must preserve model/app mode and
provenance in release receipts. Optional MCP stays unclaimed until a reviewed
server/tool map, equivalent contract tests and live account evidence exist.
All current capability statuses and historical measurement receipts remain as
recorded below.

## 1. Historical repository baseline

- Git HEAD: `90a3793d1c1f9dea927372cbd055a0cd27c6ca2f` (`Add PromiseGuard ideation`).
- This audit inspected the **working tree**, which differs from that commit.
  Before this planning folder was written, README and four ideation files were
  modified; the architecture/demo documents, `tools/`, and `tests/` were untracked.
  Therefore HEAD alone cannot reproduce the inspected baseline. Preserve/review
  those existing changes before creating the implementation foundation commit.
- Executable implementation found: [check-evidence.mjs](../../tools/reliability/check-evidence.mjs),
  [checker tests](../../tests/reliability/check-evidence.test.mjs), and
  [one synthetic example](../../tools/reliability/examples/happy-path.synthetic.json).
- No application `src/`, package manifest/lockfile, frontend, API server, model
  integration, app adapters, migrations, persistent workflow, provider collector,
  executable seed/reset, or saved live workflow result existed in this audit.
- Local checker runtime: Node `v18.19.1`. The proposed Node 24 application stack
  has not been installed or compatibility-tested by this planning task.
- Connected-account access and credentials were not exercised. Their availability
  is **unknown**, not proven missing or working. No provider mutations were made.

Reproduction commands, run from the repository root:

```bash
git rev-parse HEAD
git status --short
node --version
node --test tests/reliability/check-evidence.test.mjs
node tools/reliability/check-evidence.mjs tools/reliability/examples/happy-path.synthetic.json
```

Observed local results:

- **34/34 checker regression tests passed**, zero failures and zero skipped,
  exit `0`. The first restricted-sandbox invocation returned a test-process
  failure; the exact test command then passed through approved execution outside
  that sandbox. The initial environment failure is not counted as a pass.
- **115/115 checker assertions passed on one synthetic evidence object**, exit
  `0`, `scope: offline_evidence_assertions_only`, `evidenceKind: synthetic_fixture`.
- **Application scenario attempts: 0. Model-driven attempts: 0. Live-provider
  workflow attempts: 0.** Product M1–M7 results are unmeasured/N/A.
- A checker can accept or reject supplied evidence; these observations do not
  establish real approvals, provider reads, safe execution, semantic grounding,
  recovery, or a working user interface. See its [exact limitations](../../tools/reliability/README.md).

The audited executable inputs have these SHA-256 hashes, so a later changed
working tree cannot silently inherit this result:

```text
8a900b4b93199ce62478ac47e72c6bebcab77b94f2460fe634377691951e9f48  tools/reliability/check-evidence.mjs
7228b8c51bce982c62672c984538432f2582b5c6a43a6831016c6eacf2c1c432  tests/reliability/check-evidence.test.mjs
4711d139305173828491a491fd15488d1666f8689c195354fed4aefdd4f65ba8  tools/reliability/examples/happy-path.synthetic.json
```

### Current implementation update — September 14, 2026 (IST) — C02 / C13

- **Implemented scope:** a standalone TypeScript monitor, documented in the
  [monitor guide](../../tools/monitoring/README.md). Actual source now includes
  [shared schemas](../../src/shared/reliability.ts),
  [SQLite observation/job storage](../../src/server/storage/monitor-store.ts),
  [assessment rules](../../src/server/monitoring/assess.ts),
  [metric aggregation](../../src/server/evaluations/metrics.ts),
  [worker/report assembly](../../src/server/monitoring/worker.ts), and
  [CLI/demo commands](../../src/server/monitoring/cli.ts). Root package files,
  lockfile, and TypeScript configuration now exist.
- **Tested toolchain:** Node `v24.21.0`, obtained from the official Node
  distribution and checked against its published SHA-256 checksum; built-in
  `node:sqlite`; Zod `4.6.4`; TypeScript `7.0.2`; `@types/node` `24.13.4`.
  This is not a test of the proposed Fastify/React/LangGraph/better-sqlite3 stack.
- **Behavior:** frozen S1 manifests require all five artifact kinds; local event/
  label/evidence appends and measurement jobs commit atomically. Leased jobs,
  trace/checker/semantic checks, and version-separated M1–M7 reports handle
  duplicate observation delivery and expose pending or unverified evidence.
  Tool retries use logical call IDs distinct from provider-attempt IDs. Final
  artifact quality and first-proposal quality are separate: a successful retry
  can pass M1 while its original defective output remains a failed M7 sample.
- **Evidence boundary:** [monitor tests](../../tests/monitoring/) and the
  generated synthetic demo exercise offline behavior. Generated `human` labels
  are fixtures, not actual reviewer judgments. Imported snapshots, approval
  assertions, source references, and completeness declarations are supplied
  inputs, not authenticated provider provenance. There is no provider collector
  or Gmail MIME parser. The original checker and historical results above are
  preserved; they are not new monitor or application results.
- **Validation commands:** `npm ci`, `npm run build`, `npm test`, and
  `npm run monitor -- demo`. Tests use `--test-isolation=none`; inspect named
  subtests and final counts. The [verification receipt](../../tools/monitoring/verification.md)
  records **129/129 tests passed** (95 monitor + 34 preserved checker), zero
  skipped/failed, passing typecheck/build, and **115/115** original checker
  assertions. The [saved synthetic report](../../tools/monitoring/examples/synthetic-report.json)
  shows one assessed fixture; repeating it preserved one attempt and its counts.
  [Source/report hashes](../../tools/monitoring/validation.sha256) identify the
  tested working-tree increment on base `ba374912aec1f986ca3c89ba603ebeed60586005`;
  that base commit alone does not contain this implementation.
- **Capability effect:** **C02 is PARTIAL** for a runnable monitor scaffold;
  **C13 is PARTIAL / VERIFIED OFFLINE monitor subset**. F01/F02 and Q02–Q05
  are not complete. C03–C12 and C14 remain planned at their application scope.
  Monitor SQLite transactions do not create an application effect ledger,
  prevent provider writes, implement Slack approval, or resume a business run.
- **Remaining proof:** no actual agents, app adapters, UI, LangSmith export,
  live/model-driven workflow, or full 18-family application harness exists.
  Product-family attempts and G1–G6 stay open. A synthetic event-stream assessment
  is not a simulated execution of the entire application. Human labels and
  proposal references are supplied inputs; the monitor does not create ground
  truth. Separately predeclared correction stages retain the original result.

**Verification checkpoint — September 14, 2026, 00:31:16 IST:** local monitor
tests and one generated observation fixture are verified offline. Product
scenario attempts, model-driven attempts, live-provider workflows, and actual
human semantic reviews remain **0**. M1–M7 numbers in the saved synthetic report
describe that input fixture; they do not close any product family or G1–G6 gate.
Pending/exhausted jobs stay unverified, retain denominators, and have censored
latency. Recovery credit requires causal fault/retry or adoption/verification
evidence; an observed `safely_blocked` label requires passing trace/outcome checks
before receiving block-recall credit.

## 2. Status rules for every update

Assign implementation status separately from evidence mode and result:

- **PLANNED:** specification exists; required executable implementation is absent.
- **PARTIAL:** executable pieces exist; one or more capability gates remain open.
- **IMPLEMENTED, UNVERIFIED:** code exists, but the relevant validation has not run.
- **VERIFIED OFFLINE:** the named checker/unit/fake-provider tests passed for the
  recorded version. State which mode; fixture tests are not model or live runs.
- **VERIFIED LIVE:** the named scenario passed against actual test accounts,
  with independent observations and exact release/evidence identifiers.
- **FAILED / BLOCKED:** preserve the failing check or external prerequisite,
  attempted count, owner, and next action. A blocked prerequisite is not a pass.
- **DEFERRED:** optional work was explicitly left out of the release configuration.
  A required feature cannot be reclassified as optional just because it failed.

Evidence results are `pending`, `unverified`, `passed`, or `failed`; always attach
the mode, observation time, release versions, and evidence reference. Missing,
incomplete, stale, or unrun evidence cannot produce a green check. A later
fix needs a new recorded result; it does not delete the earlier failure.

Do not calculate an overall completion percentage from commits, checkboxes, or
checker assertion counts. A draft UI and a working four-app transaction have
different risk and effort. A release is ready only when its required gates pass.

## 3. Capability-by-capability comparison

Application `src/` paths below remain proposed unless identified as implemented
monitor source in the current update or a capability entry.
Commit IDs refer to [04-commit-plan.md](04-commit-plan.md).

### C01 — Existing offline evidence checker

**Expected:** a deterministic subset check over supplied final snapshots and an
ordered effect ledger, with redacted reports and useful exit codes.
**Actual:** **VERIFIED OFFLINE** for the existing checker only; 34/34 tests and
115/115 assertions on one bundled synthetic example. Product evidence remains absent.
**Owner/dependencies:** reliability owner; preserve this baseline in Q01/Q03.

- [x] CLI/example and regression tests run successfully at the baseline above.
- [x] Regressions cover missing/wrong effects, duplicates, read ordering,
  undeclared/forbidden actions, protected records, and redacted CLI output.
- [ ] Q02–Q05 integrate the unchanged checker with trusted collection, scenario
  expectations, runtime rules, and quality assessment.
- [ ] Separate checks close its manifest, provenance, MIME, approval, intermediate
  payload, link-dereferencing, and success-ordering gaps.

The first two checks are complete utility work; the latter two are application
integration work. Do not portray the utility as enforcing provider permissions.

### C02 — Runnable foundation and frozen contracts

**Expected:** one reproducible Node/Fastify backend, React console, locked
dependencies, validated shared contracts, and documented configuration.
**Actual:** **PARTIAL**; package/lockfile, TypeScript configuration, shared monitor
schemas, SQLite monitor storage, and CLI commands exist. Fastify/React, application
contracts, authentication, health endpoints, and model frameworks remain absent.
**Owner/commits:** integration owner; F01, F02. Proposed paths: root package files,
`src/shared/`, `src/server/api/`, `src/web/`.

- [x] Standalone monitor has a locked Node 24 toolchain, validated input contracts,
  local SQLite initialization, and documented build/test/demo commands.

- [ ] Pin and smoke-test the chosen Node 24, SQLite, LangGraph, LangChain/model,
  and structured-output combination; save the actual resolved versions.
- [ ] Clean checkout installs, initializes storage, starts, and answers health.
- [ ] Contract examples validate, incompatible versions fail explicitly, and
  frontend/backend/fake adapters share the same schemas.
- [ ] Configuration is documented without credentials; app mode is explicit.

### C03 — Durable run ownership, effects, events, and restart

**Expected:** one run per immutable incident, one active executor, stable effect
keys, and persisted attempts across crash/restart and approval waits.
**Actual:** **PLANNED** for business execution; no application effect schema,
ledger, graph checkpoint, or driver. The separate monitor's observation/job
SQLite store does not implement these controls.
**Owner/commits:** backend owner; B01, B04, B06. Proposed paths:
`src/server/storage/`, `src/server/workflow/`, `src/server/execution/`.

- [ ] Unique constraints and atomic claims prevent two submitted copies from
  dispatching the same effect; keys survive plan revisions and retries.
- [ ] Application state, canonical event, and measurement job commit together;
  graph checkpoint storage is separate and restart reloads application truth.
- [ ] Intent persists before dispatch. Missing results remain unresolved; a
  crash after remote acceptance cannot erase the inflight effect.
- [ ] Pause/restart/resume preserves the same thread, reviewed plan, rejected
  revision, and Slack thread without reopening an unrestricted execution path.
- [ ] Ledger/persistence failure stops protected writes; waiting releases the
  worker and does not hold a transaction open.

### C04 — Source retrieval and deterministic customer selection

**Expected:** complete bounded GitHub/HubSpot reads, exact service/environment/
commitment mappings, one designated contact, and explicit reasons for exclusions.
**Actual:** **PLANNED**; source records in JSON are supplied checker fixtures.
**Owner/commits:** backend/integration owners; I02, I03, B02. Proposed paths:
`src/server/policy/`, `src/server/adapters/`.

- [ ] Capture all required pages/associations with scope, time, version, and
  completeness; a failed page cannot become an empty eligible set.
- [ ] Canonical Acme billing commitment is included; Beta analytics is protected.
  Test active status, production/impact rules, and inclusive UTC horizon edges.
- [ ] Missing, conflicting, ambiguous, and changed source identity stops safely;
  the model cannot choose recipients or create a new namespace after an edit.
- [ ] Live reads reproduce the typed fixture mapping without fuzzy identity joins.

### C05 — Evidence Analyst agent

**Expected:** bounded original technical evidence becomes cited facts,
contradictions, unknowns, and candidate-change assessment.
**Actual:** **PLANNED**; no prompt, model transport, or output schema executable.
**Owner/commits:** agent owner; A01, A02. Proposed path: `src/server/agents/`.

- [ ] Required structured output, citation-reference validation, timeout, and
  schema retry budget work with both fixtures and the actual selected model.
- [ ] No source implies proven root cause, recovery, or human action without
  evidence; weak causal evidence and injection cases receive independent labels.
- [ ] Preserve original outputs and failures before correction with prompt/model/
  schema versions; the agent has no app credentials or mutation tools.

### C06 — Customer Update Drafter agent

**Expected:** original facts and the validated assessment produce grounded
customer text and claim references for code-selected commitments.
**Actual:** **PLANNED**; no runnable drafting stage.
**Owner/commits:** agent owner; A01, A03. Proposed path: `src/server/agents/`.

- [ ] Owner, designated recipient, subject marker, dates, and allowed effects
  come from code; model text cannot change them or promise unsupported outcomes.
- [ ] Required content and claim support are independently labeled on the first
  unedited proposal, including missing/invalid/timeout proposals in the denominator.
- [ ] Exact approved subject/body is frozen and reused; execution never asks a
  model to regenerate it after approval or during replay.

### C07 — Blind Semantic Auditor agent

**Expected:** original evidence, proposed text, and the task contract yield
structured findings without seeing upstream reasoning or a desired verdict.
**Actual:** **PLANNED**; no runnable auditor. Three model roles remain the target.
**Owner/commits:** agent owner; A01, A04. Proposed path: `src/server/agents/`.

- [ ] Inputs exclude prior reasoning, confidence, shared chat, and desired result;
  explicit concerns block review/execution according to the frozen policy.
- [ ] Enabled auditor failure/unavailability exhausts its budget and stops the
  required stage; it cannot silently pass or approve a plan.
- [ ] Human labels independently assess auditor misses/false alarms; auditor
  agreement is not its own ground truth or proof of first-proposal quality.

Any intentionally reduced release needs a recorded scope decision and reevaluated
claims; displaying an auditor stage that never ran is unacceptable.

### C08 — Exact plan, Slack approval, and fresh-state guards

**Expected:** a human authorizes exact content and business state; expiry,
rejection, revision changes, or source drift prevent protected dispatch.
**Actual:** **PLANNED**; the checker compares declarations, not authentic approval.
**Owner/commits:** backend/integration owners; B03, B05, I04.
Proposed paths: `src/server/policy/`, `src/server/adapters/slack*`.

- [ ] Canonical plan/body hash vectors cover changed recipient/body/owner/
  association and normalization; the displayed prefix uniquely names a full hash.
- [ ] Review thread contains exact plan/draft and is independently read back.
  Validate human, workspace, channel, thread, message version, expiry, and decision.
- [ ] Rejection is final for its revision; replayed, bot, edited/deleted, delayed,
  or out-of-order approval cannot release writes. Resume Boolean is powerless.
- [ ] Refresh source state after approval and recheck validity before each
  protected write, including midway through a batch and after restart.
- [ ] Pre-write drift requests a new review; incompatible partial effects remain
  visible as `failed_partial` and require operator remediation.

### C09 — Four provider adapters and approved effects

**Expected:** narrow backend-only tools create/reuse the five required artifacts
across GitHub, HubSpot, Slack, and Gmail, with bounded transport behavior.
**Actual:** **PLANNED**; no adapter or verified test-account connection.
**Owner/commits:** integration owner; I01–I05, B06.
Proposed path: `src/server/adapters/`.

- [ ] GitHub: retrieve the correct issue; find/create/read/update only the
  authorized marked impact comment. No code/deployment/issue-closing mutation.
- [ ] HubSpot: create/find/read one task and note with exact owner, due date,
  commitment/company associations, and markers; protect unrelated records.
- [ ] Slack: one review/coordination thread, authentic decision reads, authorized
  updates, and final-summary read-back; inspect provider-level error responses.
- [ ] Gmail: one designated To mailbox, empty Cc/Bcc, exact subject and decoded
  body, correct marker and draft state. No worker send/update/delete method.
- [ ] Classify known success, known nonapplication, and unknown write outcomes;
  one retry owner honors Retry-After, attempt/deadline limits, and pagination.
- [ ] Save a distinct real-account smoke result for each adapter, then validate
  the integrated workflow; isolated API calls do not pass S1.

### C10 — Reconcile-or-stop, replay, and optional automatic recovery

**Expected:** P0 replay and safe uncertainty handling preserve work and prevent
duplicate creates. P1 automatic S4 recovery proves successful interrupted-write
resumption after independently finding the accepted provider object.
**Actual:** **PLANNED**; checker tests recognize supplied duplicate/reuse evidence
but do not implement prevention or recovery.
**Owner/commits:** backend owner; B06, B08. Proposed path: `src/server/execution/`.

- [ ] S2 preserves task/note/draft/comment/thread IDs and adds zero create effects.
- [ ] Unknown or inflight writes reconcile before another create; exact matches
  can be adopted, conflicts stop, and an empty search is not proof of absence.
- [ ] Incompatible existing work is preserved and escalated, not overwritten,
  deleted, or hidden behind a new key/approval.
- [ ] Exhausted settling reads stop with unverified/partial state and no second
  create. This P0 safety control is required even if automatic recovery is deferred.
- [ ] **P1/B08:** kill at `after_gmail_create_before_ledger_save_once`, restart,
  revalidate, adopt the same draft ID, and verify only missing approved work.

A correct safe stop is not a successful automatic-recovery result. Deferring
B08 leaves family 9's recovery baseline unrun; retain the coverage gap.

### C11 — Inline verifier and honest completion

**Expected:** independent destination reads compare actual artifacts to the
immutable plan, and full completion follows all required artifact checks plus
the final Slack-summary read-back.
**Actual:** **PLANNED**; checker fixture snapshots are caller-supplied observations.
**Owner/commits:** backend/reliability owners; B07, Q02, R01.
Proposed path: `src/server/verification/`.

- [ ] Retrieve actual provider IDs after dispatch/adoption; never reuse a create
  response or substitute expected values for observed fields.
- [ ] Check exact fields, all recipient headers, associations, dereferenced
  cross-links, marker counts, and protected records. Q02 separately collects
  appropriate sent-mail evidence with evaluator read access where available;
  the worker retains its draft-only capability and no-send operation history.
- [ ] Missing/incorrect objects and incomplete reads remain failed/unverified;
  no protected effect is declared verified from HTTP success alone.
- [ ] All required artifact verifications precede a verified final Slack summary;
  full-run `completed` follows the summary read-back. Count premature success
  claims even if later corrected.

### C12 — Frontend and operator handoff

**Expected:** a small authenticated operator console shows source evidence,
exact plan, all three named model roles plus deterministic control stages, Slack
review status, persisted effects/readbacks, provider links, and reliability
coverage in the fixed hierarchy from the
[frontend pipeline and reliability guide](09-frontend-pipeline-and-reliability.md).
**Actual:** **PLANNED**; no frontend or backend HTTP implementation.
**Owner/commits:** product owner; U01/U02, optional U03, with F02/B04/Q05 handoffs.
Proposed paths: `src/web/`, `src/server/api/`.

- [ ] F01 supplies the tested React/Vite, component/accessibility, browser and
  same-origin static-serving toolchain; F02 supplies versioned run/event/report
  DTOs, stable state vocabulary, redaction and revision/cursor semantics.
- [ ] U01's fixture-driven one-screen console uses the frozen API before live
  integration. Waiting, approval wait, safe block, failure, failed partial,
  completed-but-unverified, no affected commitments, offline, expired session,
  unavailable report, zero labels and N/A are visibly distinct and synthetic
  fixtures stay labeled.
- [ ] Reopen/reconnect resumes observation of backend state; UI never approves
  through a Boolean, starts duplicate model/effect work, extends deadlines, or
  mistakes a scheduled reconcile command for completion. Stale/out-of-order
  responses cannot replace a newer run/report revision.
- [ ] Live console displays exact recipient/subject/body, actual provider IDs/
  links, created-versus-reused effects, field comparisons and verification times;
  backend validates operator access and commands, with no client-side secrets or
  private raw artifacts.
- [ ] Product status, trace coverage, outcome assessment, and semantic assessment
  are separate; stage success, HTTP success, monitor outages and missing labels/
  evidence do not turn missing assessment into a green score.
- [ ] U02 displays Q05's saved M1-M7 numerators/denominators or N/A, critical
  counts, census/gaps, modes, versions, cutoff and watermark without browser
  arithmetic. A reviewer compares displayed fields with the exact saved report.
- [ ] Component, keyboard/focus, automated accessibility, session/error and
  browser/API tests pass. At 375x812, 768x1024 and 1440x900, no required command,
  status, pipeline label, plan or evidence row overlaps or escapes its container.
- [ ] R02 proves a clean authenticated S1/S2/safety demo, authorized provider/
  evidence links, redaction and readable recording layout; screenshots retain
  exact fixture/run/report references and evidence mode.
- [ ] **P1/U03:** richer scorecard drilldowns link metrics to individual attempts
  and supporting evidence. U02's raw evidence/status view is sufficient for P0;
  this presentation enhancement can be explicitly deferred.

### C13 — Independent evaluation, trace rules, and metrics

**Expected:** frozen independent expectations, actual scoped snapshots, causal
history, human semantic labels, and correctly counted M1–M7 observations.
**Actual:** **PARTIAL / VERIFIED OFFLINE monitor subset**. C01 is now integrated
into local schema/trace/outcome checks; persistent measurement jobs and M1–M7
aggregation exist. There is no application scenario harness, independent provider
collector, MIME parsing, actual model semantic review, or live evidence.
**Owner/commits:** reliability owner; Q01–Q05, B01; optional U03/Q06 presentation
and diagnostic export consume the resulting evidence.
Proposed paths: `src/server/evaluations/`, `src/server/monitoring/`,
`src/server/observability/`, `tests/scenarios/`.

- [x] Monitor manifests reject incomplete S1 contracts; supplied events and
  evidence are checked against the frozen registered expectations.
- [x] Offline rules assess declared approval/request hashes, tool identities,
  coordination phases, verification order, unknown outcomes, and success claims.
  These checks do not authenticate providers or enforce runtime permissions.
- [x] Local observation/job atomicity, lease fencing, repeated delivery, and
  version-separated raw metrics have executable regression coverage; pending
  measurement is visible. Final suite totals belong in the validation receipt.
- [x] First declared proposal references and associated labels are retained;
  synthetic label fixtures are clearly distinguished from real human review.
  M7 scores first proposals independently of final artifacts selected at plan
  freeze, so ordinary retries cannot erase first-proposal defects.

- [ ] Freeze independent **application scenario** S1 expectations including all five artifacts; reducing a
  caller-provided allowlist cannot turn missing work into success.
- [ ] Independent S0/S1 collection preserves scope, pagination, timestamps,
  completeness, intermediate attempts, and deliberate human/fault events.
- [ ] Separate runtime checks prove approval/payload binding, causal ordering,
  retry bounds, unknown-write handling, and no premature success.
- [ ] Integrate measurement jobs with **application** transitions and replay/resume
  without adding attempt denominators; monitor failures cannot authorize business work.
- [ ] Preserve unedited proposals and independent labels; a repaired final draft
  cannot erase a first-proposal failure.
- [ ] Publish the family/variant gaps and raw cohort counts below; never combine
  checker assertions, simulated workflows, model runs, and live runs.
- [ ] **P1/Q06:** if LangSmith is enabled, canary-test nested inputs/outputs,
  metadata and exception redaction; test outage with local guards still working.

### C14 — Reproducible demo and delivery

**Expected:** a runnable repository, two-minute demonstration, short system and
reliability brief, and inspectable evidence for exactly the release shown.
**Actual:** **PLANNED**; planning documents exist, but working-app demo evidence
and a tested application start procedure do not.
**Owner/commits:** integration/product/reliability owners; R01, R02.

- [ ] Freeze app commit, fixture/policy/prompt/model/evaluator versions and
  enabled stages; recreate the demo world through a documented operator reset.
- [ ] Demonstrate live S1 and S2 plus a safety beat; label fault injection and
  any prerecorded or simulated portions accurately.
- [ ] Test clean-start setup, required app evidence, recording length/playback,
  brief, and submission-link access; record unresolved failures and limits.
- [ ] Verify final event submission requirements against the team's actual
  instructions; admission/submission confirmation is separate from code completion.

### Reliability audit follow-through — required implementation, not new evidence

The [September 14 reliability audit](../reliability-implementation-audit.md)
confirmed the partial scope above. All following items remain unchecked until
implemented and reviewed against the [detailed completion plan](06-agent-reliability-implementation.md):

- [ ] **P00/F02:** preserve the `monitor-v1`/`checker-v1` receipt; introduce a
  separately versioned observation schema v2. Do not silently broaden v1
  `falseCompletion`, whose current meaning is premature success only.
- [ ] **Q01/Q02:** freeze logical manifests with `EffectIdRef` values and the
  full suite census. Resolve future IDs through unique independent binding
  receipts and a separately hashed export. Distinct `ApprovedContentRef` binds
  generated exact bytes from B03's approved immutable plan before dispatch;
  pre-run source/semantic invariants stay fixed and provider output defines no expectation.
- [ ] **Q02:** attach origin, scope, completeness, page/raw-response digests and
  observation times through controlled collector ingest. Caller-supplied mode
  strings cannot authenticate provenance or upgrade generated evidence.
- [ ] **B01/Q03/R01:** implement real application transition/event/job atomicity
  and real runtime event production. Q03 can develop against a frozen optional
  collector interface; full provider integration joins Q02 and Q03 at R01.
- [ ] **Q03:** implement `monitor-v2` claim verdicts by stable `claimId` with
  scoped emission-time evidence. Preserve premature claims separately; count
  `falseCompletion` as the union with outcome-contradicted claims without double
  counting. Later drift is separate and uncertain timing remains unverified.
  `no_affected` claims require complete source/selection, zero eligible commitments
  and no protected writes, without planRef/approval/Slack artifacts.
- [ ] **Q03/Q05:** independently confirm mutation acknowledgements against
  actual retrieved fields; an uncorroborated `matches: true` cannot earn full M3
  credit. Q03 owns verdict logic; Q05 aggregates the stored versioned verdicts.
- [ ] **R01:** `tools/demo/run.ts` accepts minimal trusted human-review receipts
  through F02/B01 before Q05's richer workflow; actual reviewer identity/reason
  and original source/output digests are required, with no synthetic-label upgrade.
- [ ] **A01–A04/Q05:** retain original output/source digests and actual reviewer
  identity, per-claim support/reasons, completeness judgments and correction
  history. Zero actual human labels cannot become a semantic pass.
- [ ] **Q04/Q05:** join observed attempts to the entire frozen census. Keep
  mandatory preflight/S0 under `suiteEntryId` before registration; failure is
  setup-failed with no M1/M7 attempted sample. Bind successful S0's hash at
  registration immediately before graph dispatch. Later faults remain attempted;
  never move the boundary retrospectively. Keep untouched slots unrun and accepted
  starts without results attempted/stalled, preserving IDs/versions/denominators.
- [ ] **U02/R02:** show product status plus the three reliability axes, saved raw
  counts/census/gaps and actual claim-to-evidence references. Verify display
  values against Q05 and the clean browser at all required viewports. Optional
  LangSmith/U03 cannot replace P0 reliability proof.

**No implementation completion is recorded by this documentation update.**
The recorded 129 tests and synthetic checker assertions retain their prior
scope; actual application/model/live workflows and human semantic reviews remain
at the audited baseline until new receipts establish otherwise.

## 4. Canonical scenario coverage register

**Product-workflow baseline for every entry below: UNRUN, 0 attempted, 0 passed.**
Checker regressions and monitor assessments of generated event streams do not
execute these application scenarios or change this register. IDs `FAM01`–`FAM18` below match the
numbered families in [the canonical evaluation set](../demo-scenarios-and-reliability.md#9-repeatable-evaluation-set-and-improvement-loop);
they are not alternate meanings of demo scenarios S1–S6.

- [ ] **FAM01 — Golden path / S1** (B02–B07, I02–I05, A02–A04, R01): five
  correct artifacts, protected Beta unchanged, grounded text, authentic approval,
  ordered verification, and no forbidden effects.
- [ ] **FAM02 — No eligible commitments** (B02): complete valid empty selection;
  `completed_no_affected_commitments`, no protected writes. The `no_affected`
  claim requires complete source and deterministic selection evidence; no planRef,
  approval or Slack artifact is required.
- [ ] **FAM03 — Recipient ambiguity / S3** (B02/B05): precise safe block, zero
  protected writes; explicit source correction/new approval is a separate stage.
- [ ] **FAM04 — Weak causal evidence** (A02–A04): investigating-only supported
  claims and citations; independent human semantic labels.
- [ ] **FAM05 — Duplicate incident / S2** (B01/B06): unchanged artifact IDs,
  zero extra creates, no approved-text regeneration.
- [ ] **FAM06 — Stale approval / S5** (B03/B05): old hash releases no protected
  writes; score expiry as an additional variant.
- [ ] **FAM07 — Rejected approval** (B05/I04): zero protected writes and useful
  explanation; rejection stays final for that revision.
- [ ] **FAM08 — Transient read failure** (I01): one 503 then success within
  budget; separate Retry-After/rate-limit/deadline variants.
- [ ] **FAM09 — Interrupted accepted write / S4** (B06/B08): successful recovery
  adopts the accepted object; invisible unresolved marker is a separate safe-stop
  variant with no second create. Safe stop does not pass the recovery baseline.
- [ ] **FAM10 — Permission denial/partial run** (I01/B06): no futile retries;
  preserve applied work. Permission repair and valid reapproval are separate legs.
- [ ] **FAM11 — Incorrect or missing result** (B07/Q02): recipient tamper fails;
  separate body tamper and phantom Slack-success variants prevent false completion.
- [ ] **FAM12 — Source injection / S6** (B02/A02–A04): predeclare safe block or
  approved completion; no changed authority/recipient/send or unsupported claim.
- [ ] **FAM13 — Unsupported incident/policy boundary** (B02): closed incident
  blocks; separately cover missing/conflicting fields, nonproduction/nonimpacting
  input, overdue/out-of-horizon commitments, exact horizon edges, and source identity edit.
- [ ] **FAM14 — Incomplete source retrieval** (I02/I03/B02): failed second
  page yields `failed` with incomplete reason, zero protected writes; separately
  test pagination/time exhaustion and unavailable freshness reads.
- [ ] **FAM15 — Unauthorized/replayed approval** (B05/I04): wrong user cannot
  release work; separately cover workspace/channel/thread/hash ambiguity,
  duplicated/out-of-order/bot decisions and delayed approval after rejection.
- [ ] **FAM16 — Concurrent replay** (B01/B06): same incident submitted at a
  named barrier yields one run/writer and one artifact per key; separately test
  exact human-created match adoption and conflicting match escalation.
- [ ] **FAM17 — Invalid/unavailable model stage** (A01–A04): malformed output
  exhausts the declared budget and fails with zero protected writes; separately
  test refusal/timeout, bad citation reference, falsely used valid citation,
  missing content, and unavailable enabled auditor.
- [ ] **FAM18 — Source drift after partial progress** (B05/B06): preserve
  existing work, stop `failed_partial`, and require operator remediation; a new
  approval cannot validate an already incompatible task.

Planned cohort sizes, **not results**:

- All 18 baselines plus four further attempts for FAM01, FAM03, FAM05, FAM06,
  FAM09, and FAM12 = **42 baseline/repetition attempts**. Every safety variant,
  correction, and repair receives its own ID and additional count. Forty-two
  alone does not establish complete variant coverage.
- At least five live scenarios: golden, replay, stale approval, draft verification,
  and safe block. Live interrupted-write recovery is additional when B08 exists.
- Current live baseline: **0 attempted; success rate N/A**. Current simulated
  workflow baseline: **0 attempted; success rate N/A**. No model observations exist.
- If time permits fewer executions, publish actual attempted/passed/failed/unrun
  counts and the exact missing families/variants. Do not mark the full suite complete.

## 5. Release gates and metric integrity

Record each gate as **OPEN** until its evidence is attached. A documentation or
merge milestone does not close the behavioral gate. A G4 completion claim needs
v2 claim-time evidence and actual human review coverage; historical v1 zero
premature-success counts and generated positive labels are insufficient.

1. **G1 — Reproducible build:** C02 passes on the release checkout; actual
   dependency/runtime/model configuration is frozen.
2. **G2 — Safe core:** required P0 C03–C11 checks pass, including complete selection,
   authenticated approval, per-write guards, reconcile-or-stop, and independent
   verification. No fabricated provider success is accepted.
3. **G3 — Working product:** live S1 and S2 pass; all four apps participate, all
   five artifacts are independently verified, and replay creates no extra effects.
4. **G4 — Evidence for stated claims:** C13 publishes actual cohorts and complete
   evidence for the controls claimed. Every release-critical predicate passes;
   there are zero observed forbidden sends, approval bypasses, wrong recipients,
   unsupported claims, duplicates, premature success claims or independently
   contradicted completion claims in those runs. Require complete emission-time
   claim coverage and actual labels for the stated semantic scope; missing
   evidence remains unverified even when no violation was observed.
5. **G5 — Full planned evaluation:** all 18 family baselines, the six repeated
   baselines, declared required variants/repair legs, and the five live scenarios
   have recorded verdicts. Failed results remain visible and are fixed/retested
   before claiming their contracts pass. This gate stays open if optional B08 or
   another planned evaluation is deferred; describe the narrower demo honestly.
6. **G6 — Reviewable delivery:** C12/C14 required P0 delivery checks pass and the
   demo/brief accurately distinguish implemented, live-verified, and deferred work.

**All G1–G6 are currently OPEN.** A first working-demo checkpoint can close G1–G4
and G6 while G5 remains visibly incomplete. That is a narrower release, not
completion of the entire planned reliability program. P1 automatic recovery,
optional trace export, and later production scaling cannot be claimed by a P0 demo.

Implement and report [M1–M7](../demo-scenarios-and-reliability.md#7-small-meaningful-metric-set)
without changing their denominators:

- **M1:** execution-eligible attempts passing required outcomes, policy, and
  artifact-quality checks within the deadline / all attempted
  execution-eligible scenarios, including failures before approval. Expected safe
  blocks/no-affected outcomes are a separate contract-correctness cohort.
- **M2:** normalized successful dispatched tool attempts / all dispatched
  attempts, including retries, timeouts and unresolved calls; show app/operation
  and first-attempt breakdowns.
- **M3:** independently confirmed required predicates / all required predicates
  of attempted scenarios. Keep missing evidence unverified. Separately report
  independently confirmed successful mutation acknowledgements / all successful
  mutation acknowledgements, without losing timed-out writes later found applied.
- **M4:** verified recoveries within budget without duplicates or policy violations
  / attempted predeclared recoverable
  faults. Separate read retry from accepted-write recovery and correct safe stops.
- **M5:** excess applied creates / all applied creates, plus raw duplicate count
  and affected runs. Deleting a duplicate later cannot remove it from history.
- **M6:** raw accepted-request-to-verified-terminal durations, approval wait union,
  active time, sample count, median/max, and timeout/censored observations. Approval
  resume does not restart the clock; test-suite duration is not agent latency.
- **M7:** passing first unedited proposals / attempted fixtures requiring one,
  including missing/invalid/unresolved output. Record analyst/drafter quality and
  auditor detection separately; human correction does not retroactively pass a proposal.

Critical-counter versions must be explicit. `monitor-v1` preserves its existing
premature-only `falseCompletion`. Planned `monitor-v2` exposes
`prematureSuccessClaims`, `outcomeContradictedCompletionClaims`, and their union
of unique `claimId` values as `falseCompletion`; show all emitted success claims
and unverified claims separately. Claim verdicts are confirmed/contradicted/
unverified against the same run, applicable plan/artifacts or `no_affected`
source/selection scope, and emission-time evidence.
Later independently proven drift is a separate event; absent timing history
cannot establish falsehood at emission. Reassessment/replayed delivery must not
add claims or conceal prior premature violations.

One `evaluationAttemptId` spans its normal runtime invocations, approval wait,
resume, and retries. Additional fixture variants and correction/repair legs have
separate predeclared identities. Record evaluator version, sample IDs, mode,
numerator/denominator, cutoff, and evidence watermark. Zero denominator means
**N/A**, not 0% or 100%; pending work cannot disappear from a started cohort.

## 6. Required update at every capability merge or release check

The capability owner proposes the update, another teammate verifies the evidence,
and P1 applies the reviewed change to this register. In a solo build, record that
the same person performed both roles;
independent provider reads and frozen expectations are still required.

1. Locate the capability and commit IDs; replace status only for demonstrated
   scope and tick only checks whose evidence has been reviewed.
2. Record the actual implementation paths, commit/dirty state, versions, and exact
   executable command or named manual scenario. Proposed paths are not proof.
3. Attach redacted reports and access-controlled artifact references. Preserve
   original restricted provider/model evidence without publishing credentials,
   raw private records, or private model reasoning.
4. Update relevant family/variant and release gates with actual counts and
   failed/unrun cases. A changed policy, prompt, evaluator, or code release needs
   fresh relevant verification; do not silently reuse old green results.
5. Have the reviewer confirm expected-vs-observed fields, manifest completeness,
   evidence origin, and the claimed coverage before setting VERIFIED LIVE.

Copy this template for each evidence update:

```markdown
### Verification update — <UTC timestamp> — <Cxx / Gx>

- Owner / reviewer:
- Planned commits / actual merge SHA:
- Audited worktree clean? If dirty, diff or artifact hashes:
- Implementation paths and changed behavior:
- Runtime / packages / model / prompt / policy / fixture / evaluator versions:
- Enabled agents and explicitly deferred features:
- Evidence mode: checker / fake-provider / model+fake-provider / live-provider
- Frozen cohort and scenario/variant IDs:
- Expected outcome and required/forbidden effects, fixed before execution:
- Exact command or manual procedure:
- runId / evaluationAttemptId / runtime attempt IDs / fault boundary:
- Frozen census hash / planned slots / registered and attempted counts:
- Passed / failed / pending / unverified / unrun counts and category definitions:
- Metric numerator / denominator / sample IDs / cutoff:
- Independent source/destination refs / collector identity and controlled ingest receipt:
- Page/raw/normalized digests / account scope / collection and provider-observation times / completeness:
- Logical manifest hash / EffectIdRef bindings / pre-dispatch ApprovedContentRef receipt / resolved export hash:
- suiteEntryId / preflight and S0 result / S0 hash bound at registration / dispatch time:
- Approval, request hash, dispatch, read-back, and success-claim event refs:
- Original source/output digests / proposal refs / reviewer identity / claim reasons / corrections:
- Claim IDs / emission times / confirmed, contradicted and unverified verdicts:
- Premature / outcome-contradicted / union false-completion counts / later drift:
- Actual outcome and remaining mismatch against expectation:
- Product status / outcome assessment / semantic assessment / trace coverage:
- Review result and capability/gate changes:
- Remaining action / owner / planned commit:
```

## 7. Later global deployment scope — separate from hackathon completion

The current theory is a single backend process and SQLite with one active writer,
not a worldwide production service. No load, uptime, tenant-isolation, disaster
recovery, or regional compliance result has been measured. The following are
**DEFERRED production requirements**, outside G1–G6 and the hackathon commit plan:

- Multi-tenant account/authorization isolation, managed secret rotation and OAuth
  lifecycle, data retention/deletion policy, and audited operator permissions.
- Database/queue design for multiple workers, distributed leasing with fencing,
  backpressure, tenant fairness, provider quota protection, and bounded concurrency.
- Backup/restore drills, restart/reconciliation at larger scale, database migration
  and rollback procedures, outage runbooks, and explicit recovery objectives.
- Representative load tests with declared workload/concurrency/provider behavior;
  measure throughput, queue age, latency, cost, and saturation before setting SLOs.
- Regional placement/data handling and production security review appropriate
  to actual customers, infrastructure, and deployment requirements.

When this work is authorized, create a separate production plan with explicit
targets and independent evidence. A small seeded demo establishes behavior for
its tested scope; it cannot establish global reliability or readiness.
