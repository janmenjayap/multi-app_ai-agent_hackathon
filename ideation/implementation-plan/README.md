# PromiseGuard implementation plan

This folder turns the existing proposal into reviewable implementation tasks:
what to strengthen, who builds each part, which branches can run together, what
must merge first, and how to verify completion against the actual repository.

Before implementing any branch or commit, read the
[global implementation conventions](00-global-implementation-conventions.md).
They are the normative naming, repository-layout, schema, ownership, testing,
and handoff contract for every implementation ID in this plan.

**Historical baseline: September 13, 2026.** This plan began with product/design
documents and a runnable offline checker. **Current update: September 14 (IST).**
A standalone Node 24/TypeScript/SQLite reliability monitor now implements supplied
observation storage, durable measurement jobs, trace/label checks, and grouped
metrics. Start with its [usage guide](../../tools/monitoring/README.md) to run the
synthetic demonstration. The frontend, application backend, three agents, live
adapters, authentic approval, business-effect durability, and provider collector
remain planned. See [Global Scale](Global%20Scale.md) for partial C02/C13 progress;
this increment does not complete the F01/F02 or Q02–Q05 work packages.

**Reliability implementation update:** the [audit](../reliability-implementation-audit.md)
has been converted into a [detailed delivery plan](06-agent-reliability-implementation.md).
It makes original AI quality, actual execution traces/controls, and independently
observed expected-versus-actual app state separate required proof. The 31 existing
commit briefs and 29 branch plans now include those responsibilities; none becomes
implemented merely because its plan is more detailed.

**Model-provider decision:** A01 targets stable `gemini-3.8-flash` on the Gemini
Developer API free tier through direct server-side REST. The authoritative
[LLM guide](07-agent-spawning-and-llm-integration.md) owns configuration,
structured-output, quota, data-handling, and evidence rules. No live call or
free-tier availability claim is implied until its compatibility smoke passes.

## Read and work in this order

**For implementation assignments, start with the [per-branch plans](branches/README.md)
and [individual commit files](commits/README.md).** Each proposed branch has its
own file, and every commit has its own implementation brief. The 30 original
implementation IDs are retained; P00 adds the reviewed monitor baseline before
F01. These are 31 planned commits on 29 proposed branches, not Git actions already
performed or an increase in claimed application completion.

1. [Global implementation conventions](00-global-implementation-conventions.md):
  mandatory naming, path, schema, state, ownership, validation, and handoff rules.
2. [Pipeline robustness review](01-pipeline-robustness.md): risks, existing design
   strengths, missing implementation controls, and prioritized acceptance gates.
3. [Simple agent and workflow diagrams](02-agent-workflow.md): what each agent
   does, where it runs, what it receives, and where ordinary code controls work.
4. [Per-branch execution index](branches/README.md) and
   [parallel delivery](03-parallel-delivery.md): four-person
   allocation, execution waves, safe parallelism within chunks, merge rules,
   and adaptations for smaller teams.
5. [Individual commit plans](commits/README.md), indexed by the
   [combined backlog](04-commit-plan.md): named branches, commit IDs, owned files,
   prerequisites, ordered steps, what to do/avoid, and proof needed for each handoff.
6. [Shared contracts and handoffs](05-contracts-and-handoffs.md): precise interfaces
   that let UI, backend, adapters, agents, and evaluators develop independently.
7. [Global Scale.md — completion verification](Global%20Scale.md): expected
   behavior versus real code/evidence, current status, capability gates, and the
   living release checklist. Update it after reviewed implementation changes.
8. [Agent reliability implementation](06-agent-reliability-implementation.md):
   full producer → independent collection → assessment → labels → scorecard
   pipeline, v2 evidence/claim contracts, temporal false-completion measurement,
   negative tests, and commit-by-commit acceptance evidence. Read with shared
   contracts before starting any runtime or Q-series implementation.

9. [Agent spawning and LLM integration](07-agent-spawning-and-llm-integration.md):
   exact backend call sites, role inputs/outputs, model configuration, durable
   invocation/retry rules, and F01/F02/A01–A04/B04/R01 implementation ownership.
10. [MCP, API and external-app integration](08-mcp-api-and-external-app-integration.md):
   GitHub/HubSpot/Slack/Gmail operations, REST endpoints/access, optional MCP
   transport binding, dependency injection, smoke checks and per-commit delivery.
11. [Frontend pipeline and reliability](09-frontend-pipeline-and-reliability.md):
  canonical one-screen hierarchy, pipeline and agent semantics, minimum browser
  DTOs, complete UI state matrix, responsive/accessibility rules, browser tests,
  demo framing, and exact U01-U03 parallel handoffs.
12. [Parallel branch and merge runbook](10-parallel-branch-and-merge-runbook.md):
  dependency-ready scheduling, merge checkpoints, and integrated validation.

## Decisions this plan makes

- Target one deployable application and the existing four business apps:
  GitHub, HubSpot, Slack, and Gmail. Email remains draft-only.
- Target three bounded backend model roles: Evidence Analyst, Customer Update
  Drafter, and Blind Semantic Auditor. Selection, approval, execution, and
  completion authority remain in code.
- “Spawn an agent” means invoke one of those role functions from the backend
  graph through A01's bounded LLM wrapper. R01 composes the call sites; no dynamic
  agent fleet or separate process is needed. REST adapters are the four-app MVP;
  MCP can later implement their typed transport after capability/conformance checks.
  A Codex plugin connection does not supply deployed application credentials.
- Freeze contracts before parallel feature branches. Preserve one owner for
  dependency locks, shared schemas, migrations, and graph/API composition.
- Develop independent modules concurrently, then integrate in dependency order.
  Keep protected writes sequential per incident and verify each result.
- Preserve the existing checker. Build real collection, runtime rules and
  quality review around it; synthetic checker passes are not live agent success.
- Preserve monitor-v1 history; implement the expanded observation/claim contract
  as proposed schema v2 and evaluator `monitor-v2`. A final-state mismatch must
  be distinguishable from premature success and from known later provider drift.
- Freeze suite census and logical expected effects independently. Unknown future
  provider IDs use constrained identity bindings, never post-hoc expected-field
  copies. Collect actual model outputs and human labels before claiming AI quality.
- Treat local execution and evidence as the core release. Hosted deployment,
  richer dashboards, optional telemetry, and production scaling are later work.
- Require U02's compact pipeline and reliability surface for release. Keep U03's
  cohort/claim drilldowns optional, but do not defer product, trace, outcome,
  first-proposal, census, or evidence-gap visibility from the basic console.

The plan assumes four contributor roles, not four full-time people already
available. Its 30 implementation tasks plus one baseline commit are a dependency breakdown, not a promise that
all can fit the remaining event time. Select deadlines using the actual cutoff
and protect evaluation/recording time. Optional tasks are labeled in the ledger.

## Source precedence

- [Final proposal](../final-project-promiseguard.md) defines the selected product.
- [Demo scenarios and reliability](../demo-scenarios-and-reliability.md) is the
  canonical scenario, metric, evidence, and demo acceptance contract.
- [Architecture](../promiseguard-architecture.md) defines the intended stack,
  graph, storage, approval, execution, and monitoring design.
- [Requirements and timeline](../requirements-and-timeline.md) supplies the
  documented event constraints; confirm current participant instructions before
  submission. This task did not recheck admission or event announcements.
- This folder refines delivery and verification. It does not silently replace
  those contracts. Resolve a conflict in a reviewed decision before coding.
- The audit is a dated observation; plan 06 specifies subsequent work. Neither
  edits old measurement receipts nor turns planned v2 capabilities into results.

## Start the team

Assign P1–P4, follow [P00](commits/P00.md) to preserve the reviewed shared baseline,
then complete the application portions of F01/F02 and account-access checks.
Preserve and integrate the existing monitor instead of rebuilding it. Open parallel feature work once
the shared interfaces are frozen. Use each task's acceptance evidence to update
[Global Scale.md](Global%20Scale.md); a merged file without passing behavior is
not a completed capability.
