# PromiseGuard

PromiseGuard is a proposed incident-to-customer-follow-up agent across GitHub,
HubSpot, Slack, and Gmail. It is intended to create approved, assigned recovery
work and a verified customer email draft.

**Current status:** product planning plus an executable offline evidence checker.
The application, model agents, connected-app adapters, approval flow, and durable
recovery are not implemented. No live integration success is claimed.

## Run the available reliability checks

No dependencies or credentials are needed. The checker uses Node.js standard
library APIs and has been verified locally with Node 18.19.1. The intended app
deployment runtime is Node 24, as described in the architecture.

```bash
node --test tests/reliability/check-evidence.test.mjs
node tools/reliability/check-evidence.mjs tools/reliability/examples/happy-path.synthetic.json
```

The example contains **synthetic evidence**. The command checks supplied records
and operation history; it does not contact external apps or run an agent. Test
passes measure the checker, not product reliability. See the
[checker guide](tools/reliability/README.md) for its input contract, exit codes,
and limitations. Keep real exported evidence private; only synthetic examples
belong in this repository.

## Project documents

- [Implementation plan: robustness, agent workflow, parallel branches, and commit tasks](ideation/implementation-plan/README.md)
- [Global Scale: expected versus implemented behavior and completion verification](ideation/implementation-plan/Global%20Scale.md)
- [Requirements and timeline](ideation/requirements-and-timeline.md)
- [Final PromiseGuard proposal](ideation/final-project-promiseguard.md)
- [Fine-grained LangGraph/LangChain architecture and trace-monitoring pipeline](ideation/promiseguard-architecture.md)
- [Demo scenarios, measurement plan, and implementation status](ideation/demo-scenarios-and-reliability.md)

The demo plan distinguishes proposed live workflows from the runnable local
checker and is the canonical reliability acceptance contract. It defines
18 scenario families, first-proposal grounding checks, approval and concurrency
tests, partial-failure handling, and the evidence required for each demo claim.
The proposed evaluation counts are targets; no live or model-driven attempt has
been recorded. Older ideation briefs are labeled historical alternatives.

The architecture now specifies LangGraph checkpoints and approval interrupts,
LangChain structured agents, masked LangSmith traces, and a separate local
reliability monitor. These remain proposed; the main four-app workflow and the
runnable offline checker are unchanged.
