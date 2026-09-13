# Contracts and handoffs

**F02 execution update, September 14, 2026:** the six shared application modules
below now have reviewed schema-2 implementations and executable accepted/rejected
examples, merged into local main. See the [F02 receipt](commits/F02.md#completion-receipt)
for exact SHAs, conventions 1.2, compatibility and passing checks. Remote
publication remains separate; the historical baseline and proposed
runtime/evaluator behavior below must not be read as completed implementation.

**Historical baseline: September 13, 2026.** The application contracts below
were proposed before `src/` existed. **September 14 update (IST):** the Node 24
[standalone monitor](../../tools/monitoring/README.md) now has executable schemas
in `src/shared/reliability.ts`, SQLite measurement storage, and offline assessment/
metric modules. F02 still must deliver the broader application/agent/adapter/API
contracts below before feature branches integrate. F01/F02 and Q02–Q05 remain
partial; the current monitor does not implement the product app or provider collection.
See [commit tasks](04-commit-plan.md) and [completion evidence](Global%20Scale.md).
The [detailed reliability implementation](06-agent-reliability-implementation.md)
adds the audit's missing producer, provenance, original-output, census, and
completion-claim contracts. Everything marked v2 below is proposed; the existing
monitor-v1 implementation and its verification receipt retain their current meaning.

## 1. Freeze the seams first

P1, the backend/integration owner, owns `src/shared/`, root dependency files, migrations, and
the graph composition file. Other contributors request a small contract change
instead of changing shared types independently. A reviewed additive contract
commit merges before its consumers; a breaking change names all affected branches
and reruns their conformance tests. Record a `schemaVersion` on persisted artifacts
and API projections; an unsupported version must fail explicitly.

F02 supplies these proposed files:

- `src/shared/domain.ts`: incident identity, snapshot references, selection,
  immutable plan, approval, effect, and public run status.
- `src/shared/agents.ts`: the three role input/output contracts and validation
  results. Each role implements the agreed function without importing another
  role's implementation.
- `src/shared/adapters.ts`: separate source reads, Slack coordination, protected
  mutations, and verification reads; typed transport outcomes and completeness.
- `src/shared/api.ts`: command, response, event cursor, and redacted UI types.
- `src/shared/events.ts`: attempt identities, causal events, measurement jobs,
  and allowed error codes.
- `src/shared/evaluation.ts`: frozen manifests, evidence modes, assessment
  states, labels, and metric facts.

F02 also owns additive changes to the existing `src/shared/reliability.ts` and
its compatibility projections. Keep one shared definition for each concept;
application files must not introduce competing manifest/event/label vocabularies.
Freeze observation schema v2, evaluator `monitor-v2`, and the old-v1 read path
before consumers merge. The dependency-free checker-v1 format is unchanged.

F02 provides at least one accepted and rejected JSON example per boundary.
Q01 owns scenario fixtures under `tests/fixtures/` and fake implementations under
`tests/fakes/`; it consumes F02 instead of defining a competing domain schema.
Shared examples establish shape, not the truth of expected business outcomes.

## 2. Source and selection boundary

**Producer:** I02/I03 adapters. **Consumer:** B02 selection and A02 analyst.

- Resolve immutable GitHub repository/issue identity before lookup or creation
  of a run. Pin incident/service/environment identity; edits cannot open another
  effect namespace.
- A snapshot carries provider/account scope, source IDs, captured time, relevant
  version/hash, evidence references, and completeness. Preserve a reason for
  incomplete retrieval rather than returning an empty success.
- A source bundle may proceed only after all required pages and associations are
  validated. Parallel reads must join at this gate; a single failure invalidates
  the bundle, even when another read succeeded.
- Selection returns exact commitment/company/owner/contact IDs, the designated
  mailbox, included/excluded reasons, and the policy version. Malformed potentially
  affected records block; the model cannot remove them from consideration.
- Use the canonical fixture policy: active exact-service commitments with
  `now <= due_at <= now + 72h`, inclusive in UTC. The fixture approval TTL is
  10 minutes and source freshness is 30 seconds. These are proposed fixture
  settings, not measured or deployed defaults. Use actual time for live runs.

**Handoff proof:** fail page two, supply an ambiguous contact, and exercise exact
horizon boundaries. The first case returns incomplete evidence; the second
blocks selection; only a complete valid empty set is a business no-op.

## 3. Agent boundary

**Producer:** A01 wrapper plus A02/A03/A04 role modules.
**Consumer:** B03 plan builder, R01 graph assembly, Q05 quality review.

1. **Analyst:** bounded original technical snapshots in; cited facts,
   contradictions, unknowns, and candidate-change assessment out.
2. **Drafter:** validated assessment, original facts, and code-selected commitments
   in; customer text and claim-to-source references out. Recipient, owner, subject
   marker, dates, and effect types are supplied by code.
3. **Auditor:** original source evidence, proposed text, and task contract in;
   findings with referenced claims out. Exclude previous agents' reasoning,
   confidence, shared chat history, and the desired verdict.

All three run in the backend with structured LangChain calls; none receives app
credentials or a mutation tool. Their implementations can be developed in
parallel with frozen role outputs. Actual invocation order is analyst, drafter,
then auditor. The intended release includes all three; a failed required auditor
cannot silently become an approval.

Record role/prompt/model/schema versions, snapshot references, invocation and
attempt IDs, output reference, latency, and validation outcome. Persist original
outputs, including malformed first outputs, before repair/retry; the quality
denominator includes attempts requiring a proposal even when none is usable.
Use a bounded common wrapper with one retry owner. Citation existence is a
mechanical check; whether a citation supports a claim also needs semantic review.

The original-output record includes role/invocation/model-attempt identity,
source snapshot digests, prompt/model/schema versions, received time, raw output
reference and digest, parse/validation result, and its revision relationship.
Persist raw output before validation/repair; a timeout has a recorded attempt
without a fabricated output. Q05's label binds to those exact source/output
digests and includes a reviewer reference, reason, time, four quality dimensions,
and per-claim judgments. Adjudication creates a linked superseding label; it never
overwrites history. Original quality, final-plan quality, and auditor detection
accuracy have different denominators and must remain separate.

**Handoff proof:** each module accepts the same frozen evidence fixture and rejects
out-of-contract output. The drafter and auditor can finish unit verification
without a live analyst. R01 then tests the real three-role chain.

The concrete role invocation and transport boundaries are specified below and in
[agent spawning and LLM integration](07-agent-spawning-and-llm-integration.md).
These are F02 contracts to implement, not additional running services.

### Agent invocation contract to freeze in F02

`src/shared/agents.ts` owns `AgentRole` (`analyst | drafter | auditor`),
`AgentInvocationContext`, role-specific inputs, and `AgentCallResult<T>`.
The context contains `runId`, `runtimeAttemptId`, `planRevision`, role,
`roleInvocationKey`, `snapshotBundleRef`, `inputDigest`, prompt/schema versions,
and `modelConfigRef`. The result carries validated output/artifact references or
an explicit failure with attempt references; it cannot contain approval or an
instruction to execute an app operation.

`DraftProposal` contains a bounded set of customer-text entries keyed by the exact
selected commitment IDs: no omitted, duplicate or additional entry. The seeded
case has one entry; multiple selected commitments retain one logical drafter
invocation per revision with complete set coverage. The auditor receives every
entry and returns commitment/claim-specific findings. Code supplies each entry's
recipient/owner/effect metadata. Reject input/set sizes outside the frozen budget
before dispatch; never silently drop selected customers or spawn extra agents.

Freeze the project functions `analyzeIncident`, `draftCustomerUpdate`, and
`auditSemantics` with `(input, context, dependencies)` signatures. A01's
`invokeRole` calls an injected model client; only its `model.ts` imports the
live model integration. These function names describe project interfaces to
implement, not SDK methods. R01's `composition.ts` supplies the dependencies and
`workflow/nodes.ts` invokes each role from `workflow/graph.ts`; B04 schedules the
graph outside HTTP. A role invocation creates a bounded model task in this same
backend, not another deployment or an unbounded agent-spawning loop.

Define `roleInvocationKey` from run/revision/role and persist its frozen input and
configuration digests. Reuse a validated durable result only when those digests
match; a mismatch requires a new authorized workflow revision. Every actually
dispatched request has a fresh `modelAttemptId`; a resume has a new
`runtimeAttemptId` without resetting the role budget or evaluation identity.
Concurrent claims cannot dispatch the same role twice. Recovery may reattempt
an unresolved model call within its original budget and record possible duplicate
provider usage; do not promise exactly-once LLM billing. A completed role awaiting
Slack approval must not run again merely because the browser polls or the worker
resumes. Before a plan is approved, required-role failure stops the language chain;
after protected effects exist, preserve them and apply the partial-failure policy.

B01/R01 allocate and persist the candidate `planRevision` before the first role
invocation. B03 freezes the exact plan candidate under that same revision
after validation/audit; allocating a revision itself grants no write authority.
Source changes allocate another revision only through the existing guarded
replanning path, preserving prior effects and original-output history.

F01 validates `PG_MODEL_MODE=mock|live` separately from
`PG_ADAPTER_MODE=fake|rest`. Only live model mode requires `OPENAI_API_KEY` and a
pinned tested model configuration; no missing credential silently selects a mock.
Freeze time/input/output/attempt budgets and a redacted configuration digest with
the invocation. Raw response capture must precede parsing and validation, including
refusals and malformed output; structured JSON conformance does not prove grounding.

**Contract proof:** three independent contexts, order enforced by graph edges,
zero calls for blocked/valid-empty selection, no repeated call after approved-plan
resume, input-digest mismatch rejected, every retry preserved, and no app credential
or tool in a role request. See A01–A04 for role implementation and R01 for assembly.

## 4. Plan, approval, and effect boundary

**Producer:** B03 plan builder and B05 approval service.
**Consumer:** B06 executor and B07 verifier.

- The immutable plan includes normalized source identity, source hashes,
  selection, policy/schema versions, exact recipient/subject/body, all effects,
  and deterministic templates for any destination IDs that do not yet exist.
- Define canonical serialization and body normalization once. Add golden hash
  vectors for key order, arrays, Unicode, line endings, empty fields, and changed
  recipient/body/association. Never let each adapter implement its own hashing.
- Approval references the stored full plan hash, revision, authorized human,
  Slack workspace/channel/thread/message identity/version, decision and expiry.
  A short hash in Slack must resolve uniquely to that stored plan.
- Re-read the review and decision. Edits, deletion, rejection, expiry, wrong
  actor/thread, and outdated revision cannot release writes. Rejection closes
  that revision permanently. A browser resume Boolean has no authority.
- Refresh the complete relevant source set after approval; check approval again
  before every remaining protected write, refreshing sources when stale.
- An effect key derives from pinned incident identity, app, stable source target,
  and action type. Plan revisions and retry attempts do not create new keys.
- A request binds an effect key to the exact approved payload hash and permitted
  substitutions. Claim and persist dispatch intent before the provider call.

New destination IDs may be represented as typed `EffectIdRef` values in the
frozen logical manifest and approved templates. A reference names an immutable
logical effect, not an arbitrary string to be replaced by worker output. B07/Q02
resolve it only through independently retrieved unique marker/identity bindings.
Keep the logical manifest hash, binding receipts, and resolved export hash
separate. ID binding must not change expected owner, recipient, body, status,
scope, or required artifact count. Missing/multiple/conflicting bindings remain
unverified or failed; they cannot shrink the manifest to the artifacts found.

Generated text uses a different `ApprovedContentRef`: Q01 freezes source facts,
required semantic content, forbidden claims, recipient, and invariant predicates
before any model call; B03 freezes exact output bytes/digest in an immutable
approved plan before protected dispatch. B07/Q02 resolve expected text only from
that plan receipt, never from the observed destination. Retain original oracle,
plan, binding, and resolved export hashes separately. Exact-byte equality proves
faithful execution, not semantic truth; original-output labels/M7 stay independent.
Deterministic canned-text fixtures may freeze exact bytes before invocation.

The effect row tracks `planned -> inflight -> applied -> verified`. Keep richer
attempt outcomes separately, including `unknown`. A timeout is not proof of
nonapplication. An unresolved inflight effect retains its claim and must reconcile
or stop partial before any further create for that key.

**Handoff proof:** a body edit changes the plan hash; a delayed approval cannot
revive a rejected revision; a crash after provider acceptance does not cause a
second create. Exactly matching existing effects may be adopted with evidence;
conflicting or human-edited effects require manual review.

## 5. Adapter and verifier boundary

I01 supplies the shared bounded transport. Each adapter exposes narrow methods
and receives credentials through server-side configuration. Its contract suite
uses the same tests for fake and real-response fixtures, with a separate live
smoke result. Do not add a generic model-callable HTTP method.

- **GitHub / I02:** source reads and marked comment find/create/get/update.
- **HubSpot / I03:** complete commitment/contact/owner/association reads and
  task/note find/create/get. Preserve company and commitment associations.
- **Slack / I04:** review post/update/get, approval-thread reads, and summary
  read-back. Check API-level failure as well as HTTP status.
- **Gmail / I05:** marked draft find/list/create/get. Parse all actual To/Cc/Bcc
  headers; require one designated mailbox, no Cc/Bcc, exact decoded body and
  subject, and draft state. No send/update/delete on the worker interface.

A read result distinguishes complete success, definitive failure, and incomplete
evidence. A mutation result distinguishes known application, known nonapplication,
and unknown outcome. Transport retry policy must not blindly retry a create.

B07 uses the read capability, independently retrieves the destination object,
and compares against the approved expected fields. It must not accept the create
response as its observation. Q02 collects a separate before/after evidence bundle
for evaluation; shared parsing code is acceptable, worker success flags as the
oracle are not. Where supported, inject a separate read-only client into collectors.

`ProviderObservation` v2 includes `observationId`, `collectionId`, app/account
scope, source/provider ID, request/read-attempt identity, capture start/end UTC,
within-process monotonic duration, provider version where available, observed
field digest, restricted raw response reference/hash, pagination/completeness,
and failure reason. Bind a runtime verification to its expected predicate set,
plan hash, effect key, provider ID, and specific observation; `matches: true`
alone cannot substantiate integrated outcome or M3 verification credit.

Collector provenance is attached by a controlled ingest route to observations
made using its configured reader/account. Mode, actor, and credential-reference
fields from manual JSON are untrusted declarations. Imported evidence can still
be assessed offline, but cannot gain live collection status by selecting
`imported_provider_snapshot`. Preserve all three existing modes and report the
additional provenance/coverage dimension separately.

**Handoff proof:** extra recipient, wrong association, missing draft, premature
Slack success, and a tool acknowledgement without an actual object all fail the
appropriate gate. Mark an unavailable read unverified. Fixture reset/cleanup
utilities are operator-only and run outside the scored evidence window.

### App transport and dependency-injection contracts

The [MCP/API and external-app guide](08-mcp-api-and-external-app-integration.md)
defines the exact provider operations, configuration, access smoke checks and
optional MCP mapping. F02 owns these interfaces in `src/shared/adapters.ts`;
I01 implements transport/error normalization and I02–I05 implement app methods.
R01 `src/server/composition.ts` constructs the clients and injects capabilities:

- `workflow/nodes.ts` reads GitHub and HubSpot through I02/I03 before passing a
  complete bundle to B02's pure incident/identity/selection policy. B02 owns no
  new network collector and receives no model decision about eligible customers.
- B05 `workflow/review.ts` and `approval-wait.ts` use I04 Slack coordination/read
  capabilities. Approval comes from freshly retrieved authorized human messages;
  a tool-call confirmation, MCP approval or model audit is not business approval.
- B06 `execution/executor.ts` receives only the approved narrow HubSpot task/note,
  Gmail draft and GitHub comment operations. Dispatch still requires B01 effect
  claim, B03 exact payload/hash and B05 guard, regardless of REST or MCP transport.
- B07 `verification/readback.ts` uses fresh reads. Its `finalize.ts` has narrowly
  scoped Slack summary coordination plus separate summary readback. Q02
  `evaluations/provider-readers.ts` receives independently invoked read capabilities
  and its own collection identity; it cannot adopt the write response as evidence.

Freeze `AdapterMode` and a transport-neutral call context containing app/account
scope, operation, `logicalCallId`, `providerAttemptId`, deadline, trace identity,
and, for mutations, approved effect key/request digest. Keep credentials and
clients out of the context, graph state, model prompts and public events. Record
transport kind separately from evidence mode and trusted collection provenance.
Model execution mode and provider execution/provenance are independent versioned
dimensions: mock-model/fake-app, live-model/fake-app, mock-model/live-app and
live-model/live-app runs have different proof. Freeze their representation in
F02 evaluation/API contracts without changing legacy evidence-mode values or
trusting user-supplied provenance. Combined live claims require both live model
and live provider evidence from the same registered attempt.
Existing complete/incomplete reads and applied/not-applied/unknown mutation
semantics apply to both transports. HTTP 200 or an MCP response alone cannot
establish business success.

The required MVP supports `fake` and `rest`. A future `mcp` selection must fail
configuration validation until a reviewed I01 transport implementation and each
selected app's I02–I05 operation map pass the same contract suite and live smoke.
No automatic switch between transports after a failed/unknown write is allowed.
An MCP binding pins server identity, negotiated protocol/capabilities, allowlisted
tool name and schema digest, argument/result mappings, pagination and auth/account
scope. Tool descriptions/annotations do not grant authority; model inputs never
receive the server's tool catalog. Missing full readback or exact write capability
means that transport cannot satisfy the app contract. Codex plugin installation
and OAuth connections in this editor do not configure the deployed backend.

**Contract proof:** fake/live selection is explicit, wrong account rejected,
read-only consumers cannot call mutations, partial pages fail completeness,
MCP tool/schema drift fails closed when that extension is enabled, unknown writes
require reconciliation, and separate read receipts establish actual results.

## 6. HTTP and UI boundary

**Producer:** backend API owner. **Consumer:** U01/U02/U03 frontend.

Use the [frontend pipeline and reliability guide](09-frontend-pipeline-and-reliability.md)
for the minimum DTO fields, fixed pipeline semantics, browser lifecycle, complete
state matrix, responsive/accessibility behavior, and release browser checks. F02
owns the final names and schemas; frontend branches do not fork this contract.

Freeze these existing architecture routes in F02:

- `POST /api/runs`: validated incident URL; return persisted run ID and current
  status quickly, reusing the business run on duplicate submission.
- `GET /api/runs/:id`: redacted evidence, exact reviewable plan for the authorized
  operator, approval state, effect states/links, and verification timestamps.
- `GET /api/runs/:id/events?after=<cursor>`: bounded ordered events with an opaque
  continuation cursor and explicit next cursor; reconnects deduplicate event IDs.
- `POST /api/runs/:id/reconcile`: schedule eligible inspection/resumption; it does
  not grant approval, overwrite effects, or accept arbitrary graph state.
- `GET /api/evaluations/latest`, `GET /api/runs/:id/trace`,
  `GET /api/runs/:id/assessments`, `GET /api/metrics?cohort=<id>`: versioned
  read-only evidence views with explicit coverage and observation times.
- `GET /healthz`: readiness only after storage/checkpoint initialization.

HTTP errors have a stable code, retryable flag, and correlation ID; no raw
provider exception or token. Validate input, operator session, run access, and
CSRF on commands. Use authenticated same-origin polling for the MVP, approximately
every two seconds while active, with overlap prevention and backoff on failure.
Closing the UI does not cancel a persisted run.

Separate `productStatus`, `traceAssessment` (including trace coverage),
`outcomeAssessment`, and `firstProposalAssessment`. If selected-plan semantic
quality is also exposed, name it separately; never substitute it for first-proposal
quality. Show waiting, pending, incomplete, unverified, failure and N/A explicitly.
The v2 read projection additionally includes evaluator and manifest versions,
evidence watermark/provenance, required-field comparison verdicts, completion-
claim classifications, missing-evidence reasons, raw metric numerators/
denominators, and suite census entries. The browser renders server facts; it does
not recompute metrics.
The public success outcomes are `completed` and
`completed_no_affected_commitments`; `safely_blocked`, `failed`, and
`failed_partial` describe stopped runs. `awaiting_approval` is resumable waiting.
Internal stage names may show active progress without becoming invented success
statuses. Completion means verified coordination as of a recorded time, not that
an email was sent or the incident resolved.

**Handoff proof:** U01 uses contract-valid synthetic API fixtures before B04
exists. U02 substitutes the real client and tests refresh/reopen/reconcile without
changing component contracts. Slack remains the approval surface.

## 7. Evidence and measurement boundary

**Producer:** B01 canonical events, Q01 manifests, Q02 collector.
**Consumer:** Q03 rules, Q04 scenarios, Q05 metrics, U03 scorecard.

- One business incident has one `runId`. Each graph invocation/resume has its own
  `runtimeAttemptId`. A predeclared `evaluationAttemptId` spans normal approval
  waits/resumes/retries; those do not create new success-rate observations.
- Record schema version, event ID, local sequence, causal parent, run/evaluation/
  runtime attempt IDs, plan revision/hash reference, effect key, request hash,
  actor, operation, outcome, capture time, mode, and evidence references.
- Commit an application transition, its canonical event, and measurement job
  together in application SQLite. Graph checkpoints use a separate store and
  do not share that transaction. Missing dispatch results remain unresolved.
- Assessments use `pending`, `unverified`, `passed`, or `failed` plus evaluator
  version and evidence watermark. Job retries update an observation; they do
  not add denominators. Store numerators, denominators, sample IDs and cohorts.
- Freeze scenario expectations before execution. Keep baseline, repeated,
  variant, and correction/repair attempts identifiable. Preserve all failure
  evidence and legitimate human edits, with separately captured stage baselines.
- Keep checker assertions, fake/model-driven runs, and live-provider runs in
  distinct cohorts. A caller-supplied evidence label cannot establish provenance.

### Canonical v2 producer events

Use `stage.started`/`stage.finished`, `model.attempt.started`/
`model.attempt.result`, tool dispatch/result, `retry.scheduled`, source collection,
approval/revalidation, reconciliation, verification, wait, fault/correction,
and success-claim events. F02 owns final schemas and canonicalization examples;
B04 owns stage lifecycle, A01 model calls, I01–I05 provider normalization, and
B01 persistence. Each event includes `spanId`/`parentSpanId`, role/stage and
applicable `modelAttemptId`/`providerAttemptId`/`logicalCallId`, as well as the
evaluation/runtime identities already required. Timing uses UTC anchors plus
within-process monotonic durations; never subtract clocks from unrelated
processes as though they shared a monotonic origin.

The compatibility adapter explicitly maps legacy graph `attemptId` to v2
`runtimeAttemptId`, rejects conflicting aliases, and keeps `modelAttemptId`
separate from tool `providerAttemptId`. Missing old telemetry remains missing;
do not fabricate new attempt identities or causality to satisfy v2 fields.

Separate HTTP transport outcome, normalized provider outcome, and verified
business outcome. Preserve error class, retry reason, owner, delay, and timeout
budget. A start without a result remains unresolved and belongs in coverage;
unknown model/provider latency or usage is unavailable, not zero. Public events
contain restricted artifact references/hashes, not customer text or secrets.

### Completion claims and temporal evidence

`CompletionClaim` v2 includes unique `claimId`, run/evaluation/runtime IDs,
event sequence, emission time, scope (`artifacts`, `run`, or `no_affected`),
applicable effect set/plan reference, and supporting observations. An artifact-summary
claim excludes the summary's own not-yet-verified write; a whole-run claim includes
the final Slack readback for artifact-producing `completed`. A `no_affected` claim
for `completed_no_affected_commitments` has no plan/approval reference and requires
complete source retrieval, deterministic zero-eligible selection, protected/absence
predicates, and no protected mutation. It does not require a Slack artifact or
model calls. Reading a saved claim/status again is not a new claim.

Q03 evaluates prematurity separately from outcome-at-emission classification
(`confirmed`, `contradicted`, `unverified`). The manifest freezes allowed evidence
age, settling window, and cutoff; causal references, observation windows, provider
versions/history, and known intervening edits determine admissibility. A final
snapshot without timing cannot prove what was true when a claim was emitted.
Known later edits are separate drift; ambiguous history remains unverified.

The proposed monitor-v2 facts retain unique claim-ID sets:

- `prematureSuccessClaims`: violated required verification/order or unresolved work.
- `outcomeContradictedCompletionClaims`: admissible evidence contradicts claimed state.
- `falseCompletion`: union of those sets, deduplicated by claim ID.
- `successClaims`: all emitted claims, the denominator for false-completion rate.
- Confirmed/contradicted/unverified claim counts and evidence references; gaps
  remain visible even when the known false-claim count is zero.

Q03 owns `assess.ts`/`claim-verdicts.ts` and these classifications; Q05 aggregates
without reinterpreting evidence. A claim can be both premature and contradicted
but enters the union once. Old `monitor-v1` counters remain premature-only and
are never combined with v2. Preserve checker-v1 and prior receipts; new semantics
need their own evaluator version and verified receipt. Missing v2 fields cannot
be manufactured when importing old evidence.

### Census, labels, and assessment revisions

Q01 owns the planned suite census; Q04 registers an attempt before dispatch and
records each entry's not-run/setup-failed/attempted disposition. Keep setup failure
before registration distinct from failure of a registered agent attempt. Mandatory
preflight and S0 happen before registration; store receipts by `suiteEntryId`, then
bind their hashes at registration immediately before graph dispatch. Failed S0
stays `setup_failed` coverage with no M1/M7 attempted sample; every failure after
registration remains attempted. The boundary is frozen before outcomes. Unrun
entries are visible coverage gaps, not fictitious M1/M7 attempts. Each baseline,
repetition, variant, and repair leg has a frozen identity; ordinary retries and
resumes do not add denominators.

Q05 binds reviewer identity/reason and per-claim labels to original source/output
digests, records uncertainty/corrections/adjudications, and reports actual human
review separately from generated fixtures or model review. Missing labels cannot
pass; a later approved draft cannot erase a failed first proposal. Reports retain
manifest hash, evidence watermark, evaluator/version cohort, provenance and
sample IDs. Fresh evidence updates the assessment revision, not the attempt count.

Before Q05's full review workflow, R01's planned `tools/demo/run.ts` supplies the
minimal actual-operator review input using F02 label schemas and B01 storage.
Show original text/sources, record identity/reason/digests and review origin, and
enqueue assessment. This is real interaction, not a fixture-human flag. Q05
extends this receipt contract rather than becoming a circular prerequisite of R01.

### Transaction and dependency handoff

B01 refactors the existing monitor behind one transaction-aware application
connection: transition, event, and enqueue commit atomically. It owns migrations
and v1/v2 job/assessment identity; Q03 consumes the API after that change lands.
A separate post-commit monitor append is not sufficient. Preserve lease fencing,
exhaustion, stale-worker rejection, and assessment/job-completion atomicity.

Q03 can merge against frozen Q01 evidence fixtures without waiting for the Q02
implementation; absent collector input stays unverified. R01 must join both
Q02 collection and Q03 measurement and prove actual observations reach the
versioned assessor. Q05's final integration follows Q04. No new dependency cycle
or second monitor/database is introduced.

The existing `checkEvidence()` remains an unchanged subset checker. Q02–Q05 combine it
with frozen-manifest completeness, MIME/association checks, trusted approval,
causal ordering, deadline rules, and independent semantic evidence. Unresolved
writes do not fit checker v1: retain richer history and report incomplete instead
of converting `unknown` to `error` or dropping the attempt.

The monitor may write local assessment records, never business artifacts or
approval decisions. LangSmith is optional diagnostic export; an outage leaves
local guards active and assessments honestly pending where evidence is missing.

## 8. Pull request handoff template

Copy this into the PR body and link its completion record:

```text
Commit IDs and branch:
Owned files and any shared-contract change:
Prerequisite merged commit SHAs:
Behavior and acceptance criteria delivered:
Evidence mode, commands, exit codes, artifact references:
Failed/unrun cases and remaining limitations:
Reviewer and dependent branch to unblock:
Global Scale capability IDs updated by the integration owner:
```

Feature authors provide evidence snippets; P1 applies them to
[Global Scale.md](Global%20Scale.md) after review. This prevents simultaneous
status edits from turning the completion register into a merge-conflict hotspot.
