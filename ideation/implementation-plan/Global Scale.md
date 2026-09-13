# Global Scale: implementation and completion verification

**Current verdict: planning plus a verified offline checker; the PromiseGuard
application is not implemented.** This file compares the intended system with
observed repository evidence. It is the global completion checklist for the
[commit plan](04-commit-plan.md), not a claim of production readiness or a
percentage of work completed.

**Audit checkpoint:** September 13, 2026, 18:23:28 UTC / 23:53:28 IST.
**Scope:** GitHub + HubSpot + Slack + Gmail, with Evidence Analyst, Customer Update
Drafter, and Blind Semantic Auditor. Selection, approval, execution, and final
verification remain deterministic code. Read the [canonical demo contract](../demo-scenarios-and-reliability.md),
[architecture](../promiseguard-architecture.md), [selected proposal](../final-project-promiseguard.md),
and [event requirements](../requirements-and-timeline.md) before changing acceptance
criteria. The [contracts](05-contracts-and-handoffs.md) define branch handoffs.

## 1. Observed repository baseline

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

All `src/` paths below are **proposed destinations**, not existing source links.
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
**Actual:** **PLANNED**; no package manifest, application source, or start command.
**Owner/commits:** integration owner; F01, F02. Proposed paths: root package files,
`src/shared/`, `src/server/api/`, `src/web/`.

- [ ] Pin and smoke-test the chosen Node 24, SQLite, LangGraph, LangChain/model,
  and structured-output combination; save the actual resolved versions.
- [ ] Clean checkout installs, initializes storage, starts, and answers health.
- [ ] Contract examples validate, incompatible versions fail explicitly, and
  frontend/backend/fake adapters share the same schemas.
- [ ] Configuration is documented without credentials; app mode is explicit.

### C03 — Durable run ownership, effects, events, and restart

**Expected:** one run per immutable incident, one active executor, stable effect
keys, and persisted attempts across crash/restart and approval waits.
**Actual:** **PLANNED**; no SQLite schema, ledger, checkpoint, or driver.
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
exact plan, Slack review status, persisted effect timeline, links, and coverage.
**Actual:** **PLANNED**; no frontend or backend HTTP implementation.
**Owner/commits:** product owner; U01/U02, optional U03, with F02/B04/Q05 handoffs.
Proposed paths: `src/web/`, `src/server/api/`.

- [ ] Fixture-driven components use the frozen API before live integration;
  waiting, safe block, failure, partial, pending and N/A are visibly distinct.
- [ ] Reopen/reconnect resumes observation of backend state; UI never approves
  through a Boolean or mistakes a scheduled reconcile command for completion.
- [ ] Live console displays actual provider links and verification times;
  backend validates operator access and commands, with no client-side secrets.
- [ ] Product status, trace coverage, outcome assessment, and semantic assessment
  are separate; monitor outages do not turn missing assessment into a green score.
- [ ] **P1/U03:** richer scorecard drilldowns link metrics to individual attempts
  and supporting evidence. U02's raw evidence/status view is sufficient for P0;
  this presentation enhancement can be explicitly deferred.

### C13 — Independent evaluation, trace rules, and metrics

**Expected:** frozen independent expectations, actual scoped snapshots, causal
history, human semantic labels, and correctly counted M1–M7 observations.
**Actual:** **PARTIAL / VERIFIED OFFLINE subset only** because C01 exists; no
scenario harness, independent provider collector, local monitor, or metric engine.
**Owner/commits:** reliability owner; Q01–Q05, B01; optional U03/Q06 presentation
and diagnostic export consume the resulting evidence.
Proposed paths: `src/server/evaluations/`, `src/server/monitoring/`,
`src/server/observability/`, `tests/scenarios/`.

- [ ] Freeze complete S1 expectations including all five artifacts; reducing a
  caller-provided allowlist cannot turn missing work into success.
- [ ] Independent S0/S1 collection preserves scope, pagination, timestamps,
  completeness, intermediate attempts, and deliberate human/fault events.
- [ ] Separate runtime checks prove approval/payload binding, causal ordering,
  retry bounds, unknown-write handling, and no premature success.
- [ ] Measurement job replay/resume updates observations without adding attempt
  denominators; monitor failures show pending and cannot authorize business work.
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

## 4. Canonical scenario coverage register

**Baseline for every entry below: UNRUN, 0 attempted, 0 passed.** Existing checker
regressions do not change this register. IDs `FAM01`–`FAM18` below match the
numbered families in [the canonical evaluation set](../demo-scenarios-and-reliability.md#9-repeatable-evaluation-set-and-improvement-loop);
they are not alternate meanings of demo scenarios S1–S6.

- [ ] **FAM01 — Golden path / S1** (B02–B07, I02–I05, A02–A04, R01): five
  correct artifacts, protected Beta unchanged, grounded text, authentic approval,
  ordered verification, and no forbidden effects.
- [ ] **FAM02 — No eligible commitments** (B02): complete valid empty selection;
  `completed_no_affected_commitments`, no protected writes.
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
merge milestone does not close the behavioral gate.

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
   unsupported claims, duplicates, or premature success claims in those runs.
   Missing evidence remains unverified, even when no violation was observed.
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
- Started / passed / failed / pending / unverified / unrun counts:
- Metric numerator / denominator / sample IDs / cutoff:
- Independent source and destination evidence refs / timestamps / completeness:
- Approval, request hash, dispatch, read-back, and success-claim event refs:
- Original proposal refs / human labels / corrections:
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
