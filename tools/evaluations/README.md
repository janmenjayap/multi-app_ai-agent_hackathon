# Q04 scenario harness

Use Node 24 from the repository root:

```sh
npm exec -- tsc -p tools/evaluations/tsconfig.json
node .local/evaluation-build/tools/evaluations/run.js --suite core --output .local/q04-core
```

`core` executes golden, empty selection, recipient ambiguity and stale approval.
`--suite baseline` selects all 42 frozen baseline/repetition slots. `--suite all`
selects the complete 92-slot census. Repeat `--entry <suiteEntryId>` for individual
slots. Every invocation exports the whole census, including unselected entries.

```sh
node .local/evaluation-build/tools/evaluations/run.js --suite all --output .local/q04-all
node .local/evaluation-build/tools/evaluations/run.js --report --output .local/q04-all
```

The report command does not dispatch a graph. Reusing an output directory with
the same source/configuration preserves identities and existing results; it does
not rerun failed, stalled, or setup-failed slots. A changed implementation needs a
new directory. The report contains a digest of the actual source bytes, frozen
fixture hash, exact configuration, release versions and complete scenario rows.

The CLI exits nonzero when attempts are failed, pending or unverified, or setup
failed. Inspect those results even when the product reached `completed`. An exit
code does not establish workflow reliability.

## Evidence layout

- `census.json`: latest census, registered attempts, counts via CLI projection,
  and paths to the per-attempt databases and result artifacts.
- `census-N.json`: immutable snapshots, including starts without results.
- `artifacts/q04-<sha256>.json`: content-addressed setup and result receipts.
- `<suiteEntryId>/application.sqlite`: original model outputs, source/response
  bytes, append-only events, S0/S1 observations and Q03 assessments.
- `<suiteEntryId>/checkpoints.sqlite`: actual R01 graph checkpoints.

Directories/files use private filesystem permissions and are ignored by Git.
Q05 should join the entire census to attempts/results by their recorded IDs;
never infer an attempted denominator from assessment rows alone. Original model
output references point into the corresponding application database. A process
crash after registration stays attempted/pending when the census is reopened.
The fake provider state cannot be restored from that database, so a restarted
CLI preserves the stalled sample rather than inventing a recovered execution.

## Modes and open gates

The CLI runs the actual R01 graph/A01 model wrapper with a scripted model and
stateful fake apps, explicitly labeled `synthetic_fixture`. Synthetic Slack
decisions are scenario actor actions, not actual human quality labels.
`createScenarioRuntime` accepts explicit validated live-model/fake-provider
configuration for programmatic callers; its registration configuration must
match the harness cohort. Model faults cannot be presented as live model
behavior. Live provider orchestration and the five live scenario targets remain
unrun; this CLI never substitutes synthetic evidence for those targets.

Parent-state replay, B08 recovery, repair/human-drift and prompt-paraphrase
schedules without their required state bindings stay explicitly unrun. The
concurrent-start case uses the real driver behind a barrier. Focused tests cover
unchanged harness reopen and preserve the attempted denominator.

The frozen Q01 oracle currently differs from B03's effect/content identities,
and complete protected-record evidence is missing in the existing Q02 path.
Those failures remain in Q03 reports. Additional approved-plan field checks read
fresh Q02 records and catch wrong recipients without rewriting the oracle.
Stale approval currently produces no protected writes but the R01 driver labels
the result `failed_partial`; Q04 retains the expected `safely_blocked` contract
and records that mismatch. Claim-time evidence and human semantic review remain
unverified where the existing evidence cannot establish them.
