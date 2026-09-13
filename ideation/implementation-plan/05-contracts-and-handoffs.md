# Contracts and handoffs

**Status:** proposed implementation contract, September 13, 2026. None of the
`src/` files below exists at this planning baseline. F02 turns these agreements
into validated types and executable examples before feature branches integrate.
See [commit tasks](04-commit-plan.md) and [completion evidence](Global%20Scale.md).

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

**Handoff proof:** each module accepts the same frozen evidence fixture and rejects
out-of-contract output. The drafter and auditor can finish unit verification
without a live analyst. R01 then tests the real three-role chain.

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

**Handoff proof:** extra recipient, wrong association, missing draft, premature
Slack success, and a tool acknowledgement without an actual object all fail the
appropriate gate. Mark an unavailable read unverified. Fixture reset/cleanup
utilities are operator-only and run outside the scored evidence window.

## 6. HTTP and UI boundary

**Producer:** backend API owner. **Consumer:** U01/U02/U03 frontend.

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

Separate `productStatus`, `traceCoverage`, `outcomeAssessment`, and
`semanticAssessment`. Show waiting, pending, incomplete, failure and N/A explicitly.
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
  runtime `attemptId`. A predeclared `evaluationAttemptId` spans normal approval
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
