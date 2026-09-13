# PromiseGuard implementation plan

This folder turns the existing proposal into reviewable implementation tasks:
what to strengthen, who builds each part, which branches can run together, what
must merge first, and how to verify completion against the actual repository.

**Baseline: September 13, 2026.** The repository contains product/design documents
and a runnable offline evidence checker with synthetic tests. The frontend,
backend, three model agents, live adapters, approval flow, durable execution,
provider collector, and monitoring application are not implemented. This folder
is a plan; it does not claim those features now exist.

## Read and work in this order

1. [Pipeline robustness review](01-pipeline-robustness.md): risks, existing design
   strengths, missing implementation controls, and prioritized acceptance gates.
2. [Simple agent and workflow diagrams](02-agent-workflow.md): what each agent
   does, where it runs, what it receives, and where ordinary code controls work.
3. [Parallel delivery and branch order](03-parallel-delivery.md): four-person
   allocation, execution waves, safe parallelism within chunks, merge rules,
   and adaptations for smaller teams.
4. [Commit-by-commit tasks](04-commit-plan.md): named branches, commit IDs, owned
   files, prerequisites, what to do/avoid, and proof needed for each handoff.
5. [Shared contracts and handoffs](05-contracts-and-handoffs.md): precise interfaces
   that let UI, backend, adapters, agents, and evaluators develop independently.
6. [Global Scale.md — completion verification](Global%20Scale.md): expected
   behavior versus real code/evidence, current status, capability gates, and the
   living release checklist. Update it after reviewed implementation changes.

## Decisions this plan makes

- Target one deployable application and the existing four business apps:
  GitHub, HubSpot, Slack, and Gmail. Email remains draft-only.
- Target three bounded backend model roles: Evidence Analyst, Customer Update
  Drafter, and Blind Semantic Auditor. Selection, approval, execution, and
  completion authority remain in code.
- Freeze contracts before parallel feature branches. Preserve one owner for
  dependency locks, shared schemas, migrations, and graph/API composition.
- Develop independent modules concurrently, then integrate in dependency order.
  Keep protected writes sequential per incident and verify each result.
- Preserve the existing checker. Build real collection, runtime rules and
  quality review around it; synthetic checker passes are not live agent success.
- Treat local execution and evidence as the core release. Hosted deployment,
  richer dashboards, optional telemetry, and production scaling are later work.

The plan assumes four contributor roles, not four full-time people already
available. Its 30 commit tasks are a dependency breakdown, not a promise that
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

## Start the team

Assign P1–P4, preserve the existing working tree in a reviewed shared baseline,
then begin F01/F02 and account-access checks. Open parallel feature work once
the shared interfaces are frozen. Use each task's acceptance evidence to update
[Global Scale.md](Global%20Scale.md); a merged file without passing behavior is
not a completed capability.
