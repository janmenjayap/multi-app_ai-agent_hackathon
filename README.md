# PromiseGuard

PromiseGuard is a proposed incident-to-customer-follow-up agent across GitHub,
HubSpot, Slack, and Gmail. It is intended to create approved, assigned recovery
work and a verified customer email draft.

**Current status — September 14, 2026 (IST):** R01 assembles the durable workflow,
three model roles, four app adapters, Slack approval, and independent readback.
The executable demo uses stateful fake providers and mock model responses through
the real runtime. Live S1/S2 are **unrun**; simulated approval is not human review.
The original offline checker and standalone reliability monitor remain available.

For the hackathon, **agent reliability is a P0 deliverable with three parts**:
grounded original AI outputs judged against source facts and independent labels;
actual execution traces plus enforced approval/retry/reconciliation controls; and
independently collected provider state compared with expectations frozen before
execution. A passing trace, final response, or synthetic monitor report cannot
stand in for those combined results.

Generated text is bound through `ApprovedContentRef` to exact immutable plan bytes
before dispatch; provider observations never define the expected text. Independent
source facts and semantic criteria stay fixed, and approval does not establish
quality. A valid no-affected outcome instead uses `no_affected` claim scope with
no plan reference, supported by complete selection and absence-of-effect evidence.

The [detailed reliability implementation plan](ideation/implementation-plan/06-agent-reliability-implementation.md)
maps the remaining evidence work to the existing commits and branches: reconcile
independent S0/S1 collection with the frozen oracle, execute and label the scenario
suite, and publish a versioned scorecard with failed, unverified, and not-run cases.

## Agent and app integration

“Spawn agents” means invoke three bounded backend roles in the same process.
B04's `src/server/workflow/driver.ts` schedules R01's
`src/server/workflow/graph.ts`: A02 Evidence Analyst → A03 Customer Update Drafter
→ deterministic validation → A04 Blind Semantic Auditor. Each role calls A01's
`src/server/agents/runtime.ts`, whose `model.ts` uses the
`@langchain/openai` `ChatOpenAI` integration with OpenAI Responses. F01 pins and
smoke-tests compatible dependencies/configuration; F02 owns the shared contracts.
The roles receive scoped source data and return structured artifacts; they do
not receive app tools or credentials. This adds no operating-system process,
autonomous agent loop, or model-controlled API dispatch.

R01's `src/server/composition.ts` injects typed app capabilities: its workflow
source-read nodes call GitHub/HubSpot adapters, then B02 validates and selects
from the complete snapshots; B05 posts and verifies Slack review/approval; B06 executes approved
HubSpot task → note → Gmail draft → GitHub comment effects in order; B07 obtains
fresh readbacks and finalizes the Slack summary. Q02 independently collects
evaluation snapshots using read capabilities. I01–I05 own these adapters and
their transport. REST is the required MVP path; MCP is an optional adapter
transport only after an explicitly approved, tested operation map. Installed
assistant plugins do not provide backend credentials or live-product evidence.

The [agent/LLM integration guide](ideation/implementation-plan/07-agent-spawning-and-llm-integration.md)
and [MCP/API/external-app integration guide](ideation/implementation-plan/08-mcp-api-and-external-app-integration.md)
define call sites, wiring, access, tests, and commit ownership. R01/R02 preserve separate fake-model,
model-live, and provider-live receipts before describing an integrated live run.

## Run the simulated workflow

Use Node **24.21.0** from `.node-version` (Node 18 cannot run this package).

```bash
npm ci
npm exec -- tsc -p tools/demo/tsconfig.json
node .local/demo-build/tools/demo/run.js
```

Run from the repository root. The demo copies the required migrations, creates
temporary databases, waits for a simulated Slack decision, restarts, executes
the approved plan, and replays the same run. Its JSON reports model calls,
verified effects, and excess replay writes; temporary databases are removed on exit.
`--review` enables an optional interactive review of original outputs.

This is `synthetic_fixture` evidence. The frozen Q01 oracle and generated B03
plan still differ in effect/content bindings, so collected outcome evidence stays
unverified. Original-output quality also stays unverified without independent
human labels. The demo does not establish live S1/S2 or full scenario-suite results.

## Start the HTTP application

Copy `.env.example` to `.env`, then configure `PG_WORKFLOW_MODULE` with a trusted
local module path, such as `.local/workflow-bootstrap.mjs`. That module exports
`createCompositionOptions(config)` returning [CompositionOptions](src/server/composition.ts):
`buildWorkflow(services)` supplies the graph, frozen preflight/manifest registration,
and server-owned selection/approval policies; `auth.resolveSession` supplies trusted
operator sessions. Account-specific bootstrap and authentication are not bundled.

```bash
npm run build
npm start
```

The composed Fastify app serves the browser and authenticated `/api/runs` routes
at `http://127.0.0.1:3000`. Missing `PG_WORKFLOW_MODULE` stops CLI startup with an
explicit configuration error. The legacy `createApp()` bootstrap seam remains
available for foundation tests.

`PG_MODEL_MODE=mock|live` and `PG_ADAPTER_MODE=fake|rest` remain independent;
mock/fake modes require `PG_FIXTURE_ID` and injected fixture clients. REST mode
requires the four account configurations in `.env.example` plus
`PG_HUBSPOT_MAPPING_JSON` (or `hubspotMapping` from the trusted module), matching
[HubSpotMappingSchema](src/server/adapters/hubspot.ts). Property names and
association IDs must match the configured portal. Credentials stay server-side;
the business ledger, checkpoints, and evidence use separate ignored `.local/` paths.

## Run the local monitor

Use Node 24; this implementation was tested with **v24.21.0**. No provider or
model credentials are needed for the synthetic demonstration.

```bash
npm ci
npm run build
npm test
npm run monitor -- demo
npm run monitor -- report
```

The default database is `.local/reliability.sqlite`, which is ignored by Git.
The demo synthesizes every event, snapshot, proposal reference, and human-label
fixture. Its results are **monitor checks, not live workflow or human-evaluation
results**. The [monitor guide](tools/monitoring/README.md) covers frozen manifests,
register/append/measure/report/trace commands, persistence, metrics, and limits.

The standalone monitor uses Node's built-in `node:sqlite` and Zod. F01 tests
Fastify/React startup plus local LangGraph/checkpointer and `better-sqlite3`
compatibility. The standalone monitor's job durability is separate from the
application's guarded business-effect ledger.

## Run the original checker

The preserved checker is dependency-free and was previously verified on Node
18.19.1. It also remains part of the Node 24 test suite.

```bash
npm run test:checker
node tools/reliability/check-evidence.mjs tools/reliability/examples/happy-path.synthetic.json
```

The example contains **synthetic evidence**. The command checks supplied records
and operation history. Test passes measure the checker, not product reliability. See the
[checker guide](tools/reliability/README.md) for its input contract, exit codes,
and limitations. Keep real exported evidence private; only synthetic examples
belong in this repository.

## Project documents

- [Implementation plan: robustness, agent workflow, parallel branches, and commit tasks](ideation/implementation-plan/README.md)
- [Agent reliability: detailed implementation, evidence contracts, and release gates](ideation/implementation-plan/06-agent-reliability-implementation.md)
- [Agent spawning and LLM calls: runtime boundaries, configuration, and commit ownership](ideation/implementation-plan/07-agent-spawning-and-llm-integration.md)
- [MCP, APIs, and external apps: adapter operations, access, and integration gates](ideation/implementation-plan/08-mcp-api-and-external-app-integration.md)
- [Reliability definition and implementation audit](ideation/reliability-implementation-audit.md)
- [One plan per branch](ideation/implementation-plan/branches/README.md) and [one file per commit](ideation/implementation-plan/commits/README.md)
- [Global Scale: expected versus implemented behavior and completion verification](ideation/implementation-plan/Global%20Scale.md)
- [Requirements and timeline](ideation/requirements-and-timeline.md)
- [Final PromiseGuard proposal](ideation/final-project-promiseguard.md)
- [Fine-grained LangGraph/LangChain architecture and trace-monitoring pipeline](ideation/promiseguard-architecture.md)
- [Demo scenarios, measurement plan, and implementation status](ideation/demo-scenarios-and-reliability.md)

The demo plan distinguishes proposed live workflows from the runnable checker
and monitor and is the canonical reliability acceptance contract. It defines
18 scenario families, first-proposal grounding checks, approval and concurrency
tests, partial-failure handling, and the evidence required for each demo claim.
The proposed evaluation counts are targets; the monitor has not executed the
18-family product suite or a live/model-driven workflow. Earlier alternative
ideas remain under [ideation/exploration](ideation/exploration/).

See the [global completion register](ideation/implementation-plan/Global%20Scale.md)
for the partial monitor implementation, validation receipts, and open product gates.
