# PromiseGuard

PromiseGuard is a proposed incident-to-customer-follow-up agent across GitHub,
HubSpot, Slack, and Gmail. It is intended to create approved, assigned recovery
work and a verified customer email draft.

**Current status — September 14, 2026 (IST):** a Fastify/React application
scaffold, the original offline evidence checker, and a runnable
TypeScript/SQLite reliability monitor.
The monitor checks supplied traces, snapshots, and labels; it does not run agents
or call providers. The scaffold serves a browser entry and bootstrap health
endpoint. The four app adapters, authentic Slack approval, durable business
execution, model runtime, and operator console remain unimplemented.

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
maps the remaining work to the existing commits and branches: finish the controlled
workflow and event producers, connect independent S0/S1 collection to the tested
monitor, execute and label the frozen scenario suite, and publish a versioned
scorecard with failed, unverified, and not-run cases. This documentation update
does not implement those application capabilities.

## Planned agent and app integration

“Spawn agents” means invoke three bounded backend roles in the same process.
B04's `src/server/workflow/driver.ts` schedules R01's
`src/server/workflow/graph.ts`: A02 Evidence Analyst → A03 Customer Update Drafter
→ deterministic validation → A04 Blind Semantic Auditor. Each role calls A01's
`src/server/agents/runtime.ts`, whose `model.ts` uses the planned
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
define call sites, wiring, access, tests, and commit ownership. All paths above
are planned application modules. R01/R02 must preserve separate fake-model,
model-live, and provider-live receipts before describing an integrated live run.

## Run the application scaffold

Use Node **24.21.0** from `.node-version` (Node 18 cannot run this package).

```bash
npm ci
npx playwright install chromium
cp .env.example .env
npm run typecheck
npm test
npm start
```

Open `http://127.0.0.1:3000`. `npm test` builds both server and browser, then runs
checker/monitor regressions, application, component/accessibility, and Chromium
tests. `npm start` serves `dist/web` from the same Fastify origin as
`/api/health`. The health response reports **bootstrap readiness only**.

`PG_MODEL_MODE=mock|live` and `PG_ADAPTER_MODE=fake|rest` are independent. Any
mock/fake combination requires an explicit `PG_FIXTURE_ID`; the example uses
`bootstrap-synthetic-v1`. Live modes require the server configuration listed in
`.env.example` and fail before constructing services if it is missing. Startup
does not contact models/providers or verify account capabilities. All credentials
and private account settings stay server-side; Vite exports no environment
variables. Application data, checkpoints, and restricted evidence have separate
paths under ignored `.local/`, with actual product persistence deferred to B01.

For development, run `npm run build` once, then `npm run dev:server` and
`npm run dev:web` in separate terminals. Vite proxies `/api` to port 3000.
Focused commands are `build:server`, `build:web`, `test:app`, `test:web`, and
`test:e2e`; build before running standalone application or browser tests.
See the [F01 receipt](ideation/implementation-plan/commits/F01.md#completion-receipt)
for tested versions, scope, and remaining handoff gates.

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
compatibility. The application effect ledger remains future work; monitor job
durability does not implement business-write safety.

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
