/// <reference path="../../src/shared/checker.d.ts" />
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { test } from 'vitest';
import { createDemoHarness } from '../../tools/demo/run.js';
import { registerRunRoutes } from '../../src/server/api/runs.js';
import { projectAssessments } from '../../src/server/composition.js';
import { RunViewSchema, RunEventsPageSchema, assertPublicProjection } from '../../src/shared/api.js';
import { PIPELINE_STAGE_IDS, canonical } from '../../src/shared/domain.js';

type Harness = Awaited<ReturnType<typeof createDemoHarness>>;
const status = (harness: Harness, runId: string) => harness.services.repository.getRun(runId)!.status;
const protectedCreates = (harness: Harness) => harness.fake.observer.history()
  .filter(row => row.stage === 'scored' && row.action === 'create' && row.app !== 'slack');

async function projection(harness: Harness, runId: string) {
  const app = Fastify({ logger: false });
  registerRunRoutes(app, { driver: harness.services.driver, repository: harness.services.repository,
    readAssessments: projectAssessments, monitorReady: harness.services.monitorReady,
    auth: { clock: harness.clock, resolveSession: () => ({ operatorId: harness.ownerId,
      expiresAt: new Date(harness.clock() + 60000).toISOString(), csrfToken: 'fixture-csrf',
      allowedRunIds: '*', allowedRepositories: ['promiseguard-fixture/payments'] }) } });
  try {
    const response = await app.inject(`/api/runs/${runId}`);
    assert.equal(response.statusCode, 200, response.body);
    const view = RunViewSchema.parse(response.json());
    assertPublicProjection(view);
    const eventsResponse = await app.inject(`/api/runs/${runId}/events?limit=200`);
    assert.equal(eventsResponse.statusCode, 200);
    const events = RunEventsPageSchema.parse(eventsResponse.json());
    assertPublicProjection(events);
    return { view, events };
  } finally { await app.close(); }
}

test('simulated S1/S2: real roles and graph wait, restart, verify all four apps and replay without duplicate effects', async () => {
  const harness = await createDemoHarness();
  try {
    const baseline = harness.fake.observer.snapshot();
    const accepted = await harness.startRun();
    assert.equal(status(harness, accepted.runId), 'awaiting_approval');
    assert.equal(protectedCreates(harness).length, 0);
    assert.deepEqual(harness.model.calls.map(call => call.role), ['analyst', 'drafter', 'auditor']);
    const originals = ['analyst', 'drafter', 'auditor'].flatMap(role => harness.services.repository.listOutputs(canonical([accepted.runId, 1, role])));
    assert.equal(originals.length, 3, 'all three actual A01 attempts persist their original output');
    originals.forEach(output => {
      assert.ok(harness.services.repository.readArtifact(output.rawOutput));
      assert.equal(harness.services.repository.listReviewLabels(output.outputId).length, 0);
    });
    const analystPrompt = JSON.stringify(harness.model.calls[0]!.messages);
    assert.ok(!analystPrompt.includes('avery@') && !analystPrompt.includes('owner_101'));
    const auditorPrompt = JSON.parse(harness.model.calls[2]!.messages[1]!.content);
    assert.deepEqual(Object.keys(auditorPrompt).sort(), ['proposal', 'schemaVersion', 'sources', 'taskContract']);
    const waiting = await projection(harness, accepted.runId);
    assert.equal(waiting.view.productStatus, 'awaiting_approval');
    assert.equal(harness.preparations[0]!.registeredRunId, accepted.runId);
    assert.equal(harness.preparations[0]!.s0Hash.length, 64);

    await harness.restart();
    harness.advance(); await harness.tick();
    assert.equal(status(harness, accepted.runId), 'awaiting_approval');
    assert.equal(harness.model.calls.length, 3, 'restart cannot rerun roles or revise exact approved bytes');
    harness.approve(accepted.runId); harness.advance(); await harness.tick();
    assert.equal(status(harness, accepted.runId), 'completed', harness.services.driver.readState(accepted.runId)?.statusReason ?? '');

    const state = harness.fake.observer.snapshot();
    assert.equal(state.hubspot.tasks.length, 1);
    assert.equal(state.hubspot.notes.length, 1);
    assert.equal(state.gmail.drafts.length, 1);
    assert.equal(state.github.technicalEvidence.comments.length, 1);
    const task = state.hubspot.tasks[0]!, note = state.hubspot.notes[0]!, draft = state.gmail.drafts[0]!;
    assert.deepEqual(task.companyIds, ['company_acme']);
    assert.deepEqual(task.commitmentIds, ['promise_101']);
    assert.equal(task.ownerId, 'owner_101');
    assert.equal(task.dueAt, '2026-09-16T17:30:00Z');
    assert.deepEqual(note.taskIds, [task.id]);
    assert.deepEqual(draft.to, ['avery@acme.example.test']);
    assert.deepEqual(draft.cc, []); assert.deepEqual(draft.bcc, []); assert.equal(draft.isDraft, true);
    const plan = harness.services.repository.getPlan(accepted.runId, 1)!;
    const draftEffect = plan.effects.find(effect => effect.kind === 'draft')!;
    const approvedBody = draftEffect.payload.body.map(part => part.type === 'text' ? part.text : part.type === 'approved_content'
      ? plan.contents.find(content => content.contentKey === part.contentKey)!.text : '').join('');
    assert.equal(draft.body, approvedBody, 'provider bytes match the frozen plan');
    assert.deepEqual(state.hubspot.commitments.find(row => row.id === 'promise_102'), baseline.hubspot.commitments.find(row => row.id === 'promise_102'));
    assert.deepEqual(state.hubspot.companies.find(row => row.id === 'company_beta'), baseline.hubspot.companies.find(row => row.id === 'company_beta'));
    assert.deepEqual(state.hubspot.tickets.find(row => row.id === 'ticket_102'), baseline.hubspot.tickets.find(row => row.id === 'ticket_102'));
    assert.equal(harness.services.driver.readState(accepted.runId)!.effects.filter(effect => effect.state === 'verified').length, 5);
    assert.equal(harness.services.repository.listApprovals(accepted.runId, 1).length, 1);

    const writesBeforeReplay = canonical(harness.fake.observer.history());
    const replay = await harness.startRun();
    assert.equal(replay.runId, accepted.runId); assert.equal(replay.disposition, 'reopened');
    assert.equal(canonical(harness.fake.observer.history()), writesBeforeReplay);
    assert.equal(harness.model.calls.length, 3);
    const completed = await projection(harness, accepted.runId);
    assert.equal(completed.view.productStatus, 'completed');
    assert.ok(completed.view.revision > waiting.view.revision);
    assert.deepEqual(completed.view.stages.map(stage => stage.stageId), PIPELINE_STAGE_IDS);
    for (const stage of completed.view.stages) {
      const role = ['analyst', 'drafter', 'auditor'].includes(stage.stageId) ? stage.stageId : null;
      assert.equal(stage.role, role);
    }
    assert.notEqual(completed.view.assessments.firstProposal.status, 'pass');
    assert.notEqual(completed.view.assessments.outcome.status, 'pass');
    assert.ok(!JSON.stringify(completed).includes(harness.world.github.technicalEvidence.body));
    assert.ok(!JSON.stringify(completed).includes('dispatchStructured'));
  } finally { await harness.close(); }
}, 30000);

test('selection and blind-auditor blocks create no protected artifacts', async () => {
  for (const options of [{ suiteEntryId: 'pg-f03-baseline' }, { auditorBlock: true }, { suiteEntryId: 'pg-f02-baseline' }]) {
    const harness = await createDemoHarness(options);
    try {
      const accepted = await harness.startRun();
      assert.equal(status(harness, accepted.runId), options.suiteEntryId === 'pg-f02-baseline'
        ? 'completed_no_affected_commitments' : 'safely_blocked');
      assert.equal(protectedCreates(harness).length, 0);
      assert.equal(harness.services.repository.getPlan(accepted.runId, 1), null);
      assert.equal(harness.fake.observer.snapshot().slack.messages.length, 0);
    } finally { await harness.close(); }
  }
}, 30000);

test('independent reads catch wrong recipients and phantom Slack acknowledgements; accepted unknown writes are never recreated', async () => {
  for (const [faultScript, expected] of [
    ['incorrect_result', 'failed_partial'], ['phantom_slack_success', 'failed_partial'],
    ['interrupted_accepted_write', 'completed'],
  ] as const) {
    const harness = await createDemoHarness({ faultScript, monitorOutage: true });
    try {
      const accepted = await harness.startRun();
      assert.equal(status(harness, accepted.runId), 'awaiting_approval');
      harness.approve(accepted.runId); harness.advance(); await harness.tick();
      assert.equal(status(harness, accepted.runId), expected, `${faultScript}: ${harness.services.driver.readState(accepted.runId)?.statusReason}`);
      assert.equal(harness.fake.observer.snapshot().gmail.drafts.length, 1);
      assert.equal(protectedCreates(harness).filter(row => row.app === 'gmail').length, 1);
      const view = (await projection(harness, accepted.runId)).view;
      assert.notEqual(view.assessments.outcome.status, 'pass');
      if (faultScript === 'incorrect_result') {
        assert.equal(harness.fake.observer.snapshot().github.technicalEvidence.comments.length, 0);
      }
      if (expected !== 'completed') assert.equal(harness.services.repository.readEvents({ runId: accepted.runId, limit: 1000 })
        .filter(event => event.kind === 'success.claimed' && event.claim.scope === 'run').length, 0);
    } finally { await harness.close(); }
  }
}, 30000);
