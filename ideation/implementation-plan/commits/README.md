# Individual commit plans

Each file below is the implementation brief for **one proposed commit**, including
its exact suggested subject, branch, prerequisite IDs, ordered work, allowed
files, parallel subtasks, exclusions, checks, and evidence handoff. IDs such as
`B06` are planning identifiers, not existing Git SHAs. This task only writes plans.

There are **31 commit plans across 29 proposed branches**: the existing 30
implementation tasks plus P00 to preserve the already implemented local monitor.
The [branch index](../branches/README.md) explains the branching and merge order;
[Global Scale](../Global%20Scale.md) records actual completion separately.

All 31 briefs incorporate the [detailed reliability implementation](../06-agent-reliability-implementation.md).
Each owns concrete producer, guard, evidence, label, measurement, or delivery
obligations with negative tests and a receiving consumer. This expands acceptance
inside the existing IDs; it does not add commits or claim implementation progress.

Frontend-producing and frontend-consuming commits also follow the
[canonical frontend guide](../09-frontend-pipeline-and-reliability.md). It assigns
the screen hierarchy, pipeline semantics, minimum DTOs, state matrix, responsive
and accessibility checks, browser tests, demo path, and conflict-free handoffs to
the existing F01/F02/B04/Q01/U01-U03/Q05/R02 IDs; it adds no new commit.

For the audit gaps, begin with F02's v2 contracts, B01's atomic app/event/job seam,
A01/I01/B04's actual attempt telemetry, B07's inline readback, Q02's independent
collection, Q03's temporal completion-claim assessment, Q04's full census, and
Q05's original-output labels/metrics. R01 joins the real workflow; R02 requires
live evidence and an honest brief. Old monitor-v1 reports and checker-v1 stay
interpretable; new `monitor-v2` claims require their own tests and receipt.

## Find the LLM and app integration work

Read [agent spawning and LLM integration](../07-agent-spawning-and-llm-integration.md)
and [MCP/API and external apps](../08-mcp-api-and-external-app-integration.md).
The affected briefs now name exact call sites, configuration, injected contracts,
receiving consumers and acceptance checks:

- F01 config/packages -> F02 types -> B01 persistence -> A01 live model wrapper
  -> A02/A03/A04 role functions -> B04 scheduling + R01 graph composition.
- I01 common transport -> I02 GitHub/I03 HubSpot/I04 Slack/I05 Gmail -> R01 source
  nodes/B02 selection -> B05 approval -> B06 writes -> B07 readback/finalization.
- Q01 fixtures -> Q02 independent provider readers + Q03 actual event assessment
  -> Q04 graph scenarios -> Q05 original-output review -> R02 release evidence.
  U01–U03 consume backend facts; Q06 optionally exports sanitized diagnostics.

These are refinements inside the same 31 IDs, not executed LLM/API calls or new
commits. REST stays required; optional MCP must pass the same app contracts.

## Use a commit brief

1. Read the matching branch file and the linked prerequisites. Distinguish code
   preparation against frozen fixtures from permission to merge working consumers.
2. Assign one file owner per subtask. The implementer and independent test/fixture
   reviewer may work concurrently; join their work before declaring the commit ready.
3. Implement the allowed change and its meaningful regression tests together.
   Never create a green success placeholder merely to satisfy the planned commit count.
4. Run the named checks and record failure/unrun states, exact versions, evidence
   mode, and the resulting Git SHA. A commit title or checked box is insufficient.
5. If a planned commit becomes too large to review, split it into explicitly
   linked suffixes (for example `B06.1` and `B06.2`) and update both its branch
   brief and dependent gates before teammates consume the split. These suffixes
   are not additional commits currently planned or implemented.

The current Node 24 monitor commands are runnable. App tests, provider smoke,
scenario runners, frontend routes, and agent calls named in future commits are
acceptance requirements until their owning commits implement them. Preserve the
[existing monitor](../../../tools/monitoring/README.md) and its supplied-evidence
boundary throughout the application build.

## Shared baseline and foundation

- [P00 — Preserve the reviewed monitoring baseline](P00.md) · [`chore/monitor-baseline`](../branches/chore-monitor-baseline.md).
- [F01 — Establish the tested application skeleton](F01.md) · [`feat/foundation`](../branches/feat-foundation.md).
- [F02 — Freeze shared contracts before concurrent implementation](F02.md) · [`feat/foundation`](../branches/feat-foundation.md).

## Backend, policy, approval, execution

- [B01 — Persist authoritative application state and evidence atomically](B01.md) · [`feat/durable-core`](../branches/feat-durable-core.md).
- [B02 — Select incidents and commitments with deterministic policy](B02.md) · [`feat/selection-policy`](../branches/feat-selection-policy.md).
- [B03 — Freeze immutable plans, claims, and effect identities](B03.md) · [`feat/plan-policy`](../branches/feat-plan-policy.md).
- [B04 — Drive one durable graph invocation per incident](B04.md) · [`feat/workflow-driver`](../branches/feat-workflow-driver.md).
- [B05 — Bind Slack approval to the current plan and source state](B05.md) · [`feat/slack-approval`](../branches/feat-slack-approval.md).
- [B06 — Guard and reconcile every protected effect before dispatch](B06.md) · [`feat/guarded-execution`](../branches/feat-guarded-execution.md).
- [B07 — Verify remote artifacts independently and finalize cautiously](B07.md) · [`feat/readback-verifier`](../branches/feat-readback-verifier.md).
- [B08 — Demonstrate bounded automatic recovery after restart [P1]](B08.md) · [`feat/durable-recovery`](../branches/feat-durable-recovery.md).

## Provider adapters

- [I01 — Share bounded transport, normalization, and smoke-test plumbing](I01.md) · [`feat/adapter-core`](../branches/feat-adapter-core.md).
- [I02 — Implement GitHub incident evidence and one marked impact comment](I02.md) · [`feat/github-adapter`](../branches/feat-github-adapter.md).
- [I03 — Implement HubSpot commitments, task, and note](I03.md) · [`feat/hubspot-adapter`](../branches/feat-hubspot-adapter.md).
- [I04 — Implement Slack review, thread reads, and summary updates](I04.md) · [`feat/slack-adapter`](../branches/feat-slack-adapter.md).
- [I05 — Implement Gmail drafts and complete MIME readback](I05.md) · [`feat/gmail-adapter`](../branches/feat-gmail-adapter.md).

## Agent runtime and three model roles

- [A01 — Share a bounded, recorded structured-call wrapper](A01.md) · [`feat/agent-runtime`](../branches/feat-agent-runtime.md).
- [A02 — Add the Incident Evidence Analyst](A02.md) · [`feat/agent-analyst`](../branches/feat-agent-analyst.md).
- [A03 — Add the Customer Update Drafter](A03.md) · [`feat/agent-drafter`](../branches/feat-agent-drafter.md).
- [A04 — Add the Blind Semantic Auditor](A04.md) · [`feat/agent-auditor`](../branches/feat-agent-auditor.md).

## Frontend

Read the [frontend pipeline and reliability guide](../09-frontend-pipeline-and-reliability.md)
before implementing any entry in this section. U02 is the required compact
pipeline/reliability surface; U03 is an optional deeper inspection layer.

- [U01 — Build one fixture-backed operator screen](U01.md) · [`feat/operator-console`](../branches/feat-operator-console.md).
- [U02 — Connect durable status, Slack review, and partial-run controls](U02.md) · [`feat/operator-console`](../branches/feat-operator-console.md).
- [U03 — Add richer inspection of the measured scorecard [P1]](U03.md) · [`feat/evaluation-view`](../branches/feat-evaluation-view.md).

## Evidence, monitoring, and evaluations

- [Q01 — Freeze scenario worlds, expected outcomes, and controllable fakes](Q01.md) · [`feat/evaluation-fixtures`](../branches/feat-evaluation-fixtures.md).
- [Q02 — Collect independent scoped evidence and export checker input](Q02.md) · [`feat/evidence-collector`](../branches/feat-evidence-collector.md).
- [Q03 — Assess local events with durable measurement jobs](Q03.md) · [`feat/reliability-monitor`](../branches/feat-reliability-monitor.md).
- [Q04 — Automate scenario runs and classify faults honestly](Q04.md) · [`feat/scenario-harness`](../branches/feat-scenario-harness.md).
- [Q05 — Produce labeled quality results and reproducible metrics](Q05.md) · [`feat/evaluation-metrics`](../branches/feat-evaluation-metrics.md).
- [Q06 — Export sanitized traces to LangSmith without blocking work [P1]](Q06.md) · [`feat/langsmith-export`](../branches/feat-langsmith-export.md).

## Integration and release

- [R01 — Assemble the guarded graph and prove the first vertical slice](R01.md) · [`feat/workflow-integration`](../branches/feat-workflow-integration.md).
- [R02 — Freeze the release, verify completion, and package the evidence](R02.md) · [`chore/demo-release`](../branches/chore-demo-release.md).
