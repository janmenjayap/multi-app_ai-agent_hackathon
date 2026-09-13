import { EVALUATOR_VERSION, type Assessment } from '../../shared/reliability.js';
import { MonitorStore } from '../storage/monitor-store.js';
import { summarize } from '../evaluations/metrics.js';
import { assess } from './assess.js';

/** A bounded worker tick; scheduling belongs to the caller, never an HTTP request. */
export function processJobs(store:MonitorStore, options:{clock?:()=>number;maxJobs?:number}={}) {
  const clock=options.clock??Date.now;
  const maxJobs=options.maxJobs??100;
  if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>1000)throw new Error('invalid_worker_budget');
  const swept=store.sweep(clock());
  let processed=0,failed=0;
  for(let n=0;n<maxJobs;n++){
    const job=store.claimJob(clock());if(!job)break;
    try{
      const record=store.getAttempt(job.evaluationAttemptId);
      if(record.watermark!==job.watermark)throw new Error('stale_job_snapshot');
      const assessment=assess(record,clock());
      store.completeJob(job,assessment,clock());processed++;
    }catch{
      // Errors never authorize a run or fabricate a passing assessment.
      try{store.failJob(job,clock());}catch{/* Expired workers cannot change the new lease. */}
      failed++;
    }
  }
  const exhausted=store.listFailedJobs().length;
  return {swept,processed,failed,exhausted};
}

/** Includes registered attempts without assessments; absent work cannot disappear. */
export function readReport(store:MonitorStore, nowMs=Date.now()) {
  const existing=new Map(store.listAssessments().filter(a=>a.evaluatorVersion===EVALUATOR_VERSION).map(a=>[a.evaluationAttemptId,a]));
  const exhausted=new Set(store.listFailedJobs().map(job=>job.evaluationAttemptId));
  const assessments:Assessment[]=store.listAttempts().map(record=>{
    const saved=existing.get(record.evaluationAttemptId);
    const measurementFailed=exhausted.has(record.evaluationAttemptId);
    if(!measurementFailed&&saved?.watermark===record.watermark)return saved;
    const pending=assess(record,Math.max(nowMs,record.startedAtMs));
    const state=measurementFailed?'unverified':'pending';
    pending.status=state;pending.traceAssessment=state;pending.outcomeAssessment=state;pending.semanticAssessment=state;
    pending.firstProposalAssessment=state;
    pending.checks=[{code:measurementFailed?'measurement_job_failed':'measurement_pending',status:'unverified'}];
    pending.facts.contractPassed=false;pending.facts.recovery.passed=false;
    pending.facts.latency.censored=true;
    pending.facts.predicates.confirmed=0;pending.facts.mutationAcks.verified=0;
    for(const q of Object.values(pending.facts.quality))if(q)q.passed=false;
    return pending;
  });
  return {...summarize(assessments),generatedAtMs:nowMs,
    limitation:'Local observations only. No live provenance, provider access, application write prevention, or full scenario-suite coverage is established.'};
}

// Application composition uses B01's connection and v2 job APIs; v1 stays isolated.
import { ApplicationRepository } from '../storage/repositories.js';
import { EvaluationAttemptRegistrationSchema, LogicalManifestSchema, EVALUATOR_V2_VERSION,
  type EvaluationAttemptRegistration, type LogicalManifest } from '../../shared/evaluation.js';
import { parseMeasurementJobPolicy } from '../storage/monitor-store.js';
import { ApplicationAssessmentSchema, assessApplication, type ApplicationObservation, type ApplicationAssessment } from './assess.js';
import { sweepApplicationJobs } from './sweeper.js';

export interface ApplicationMonitorOptions {
  resolveManifest: (registration: EvaluationAttemptRegistration) => LogicalManifest;
  /** Read persisted Q02 projections only. New input must already have its B01 event/watermark. */
  loadEvidence?: (registration: EvaluationAttemptRegistration) => Partial<Pick<ApplicationObservation,
    'evidence' | 'isTrustedEvidence' | 'checkerExportBinding' | 'isTrustedReview' | 'outcomeEvidence' | 'isTrustedOutcome'>>;
  clock?: () => number;
  maxJobs?: number;
}

export function readApplicationObservation(repository: ApplicationRepository, evaluationAttemptId: string,
  options: ApplicationMonitorOptions): ApplicationObservation {
  // Snapshot all local input on the same connection. No asynchronous provider work occurs here.
  return repository.database.transaction(() => {
    const sql = repository.database.connection;
    const row = sql.prepare('SELECT * FROM attempts WHERE evaluation_attempt_id=? AND schema_version=2').get(evaluationAttemptId);
    if (!row) throw new Error('evaluation_attempt_not_registered');
    const registration = EvaluationAttemptRegistrationSchema.parse(JSON.parse(String(row.manifest_json)));
    const manifest = LogicalManifestSchema.parse(options.resolveManifest(registration));
    const events = [];
    let afterSequence = 0;
    for (;;) {
      const page = repository.readEvents({ runId: registration.runId, afterSequence, limit: 1000 });
      events.push(...page.filter(event => event.evaluationAttemptId === evaluationAttemptId));
      if (events.length > 100000) throw new Error('observation_budget_exceeded');
      if (page.length < 1000) break;
      afterSequence = page.at(-1)!.sequence;
    }
    const keys = [...new Set(events.filter(event => event.kind === 'model.attempt.result').map(event => event.roleInvocationKey))];
    const originalOutputs = keys.flatMap(key => [...repository.listOutputs(key)]).filter(output => output.evaluationAttemptId === evaluationAttemptId);
    const labels = originalOutputs.flatMap(output => repository.listReviewLabels(output.outputId));
    const latestPlan = events.filter(event => event.kind === 'plan.frozen').at(-1);
    return { ...options.loadEvidence?.(registration), schemaVersion: 2, registration, manifest,
      runId: registration.runId, evaluationAttemptId, startedAtMs: Number(row.started_at_ms), watermark: Number(row.watermark),
      events, originalOutputs, labels, plan: latestPlan ? repository.getPlan(registration.runId, latestPlan.planRevision) ?? undefined : undefined,
      readMutationOutcome: id => repository.getProviderAttempt(id)?.outcome ?? null };
  });
}

/** Bounded synchronous worker tick; the application scheduler calls this outside requests. */
export function processApplicationJobs(repository: ApplicationRepository, options: ApplicationMonitorOptions) {
  const clock = options.clock ?? Date.now;
  const maxJobs = options.maxJobs ?? 100;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 1000) throw new Error('invalid_worker_budget');
  const swept = sweepApplicationJobs(repository, options, clock(), maxJobs);
  const sql = repository.database.connection, store = repository.database.monitor;
  const policies = sql.prepare(`SELECT DISTINCT lease_ms, max_attempts, base_backoff_ms, max_backoff_ms
    FROM measurement_policies ORDER BY lease_ms, max_attempts, base_backoff_ms, max_backoff_ms`).all().map(row =>
      parseMeasurementJobPolicy({ leaseMs: Number(row.lease_ms), maxAttempts: Number(row.max_attempts),
        baseBackoffMs: Number(row.base_backoff_ms), maxBackoffMs: Number(row.max_backoff_ms) }));
  let processed = 0, failed = 0;
  for (let n = 0; n < maxJobs; n++) {
    let claimed: { job: NonNullable<ReturnType<typeof store.claimJobV2>>; policy: typeof policies[number] } | undefined;
    for (const policy of policies) {
      const job = store.claimJobV2(clock(), policy);
      if (job) { claimed = { job, policy }; break; }
    }
    if (!claimed) break;
    const { job, policy } = claimed;
    try {
      const observation = readApplicationObservation(repository, job.evaluationAttemptId, options);
      if (observation.watermark !== job.watermark) throw new Error('stale_job_snapshot');
      const assessment = assessApplication(observation, clock());
      store.completeJobV2(job, clock(), assessment);
      processed++;
    } catch {
      try { store.failJobV2(job, clock(), policy); } catch { /* A stale/expired lease has no authority. */ }
      failed++;
    }
  }
  const exhausted = Number(sql.prepare(`SELECT count(*) AS n FROM measurement_jobs j JOIN attempts a
    ON a.evaluation_attempt_id=j.evaluation_attempt_id AND a.watermark=j.watermark AND a.schema_version=2
    WHERE j.evaluator_version='monitor-v2' AND j.state='failed'`).get()!.n);
  return { swept, processed, failed, exhausted };
}

/** No aggregation here: Q05 consumes saved v2 facts and keeps every registered attempt. */
export function readApplicationReport(repository: ApplicationRepository,
  options: ApplicationMonitorOptions & { nowMs?: number }) {
  const nowMs = options.nowMs ?? options.clock?.() ?? Date.now();
  const rows = repository.database.connection.prepare(`SELECT evaluation_attempt_id,run_id,watermark FROM attempts
    WHERE schema_version=2 ORDER BY started_at_ms,evaluation_attempt_id`).all();
  const assessments = rows.map(row => {
    const id = String(row.evaluation_attempt_id);
    const saved = repository.database.monitor.listAssessmentsV2(id).at(-1);
    const jobs = repository.database.monitor.listJobsV2(id);
    const job = jobs.find(item => item.watermark === Number(row.watermark));
    if (saved?.watermark === Number(row.watermark) && job?.status === 'completed') return ApplicationAssessmentSchema.parse(saved);
    const state = job?.status === 'exhausted' ? 'unverified' : 'pending';
    let assessment: ApplicationAssessment;
    try {
      const observation = readApplicationObservation(repository, id, options);
      assessment = assessApplication(observation, Math.max(nowMs, observation.startedAtMs));
    } catch {
      // Registration/job identity survives a missing resolver or collector. No synthetic facts.
      return { schemaVersion: 2 as const, evaluatorVersion: EVALUATOR_V2_VERSION,
        runId: String(row.run_id), evaluationAttemptId: id, watermark: Number(row.watermark),
        observedAtMs: nowMs, status: state, productStatus: repository.getRun(String(row.run_id))?.status ?? null,
        traceAssessment: state, outcomeAssessment: state, semanticAssessment: state, firstProposalAssessment: state,
        claimFacts: null, checks: [{ code: job?.status === 'exhausted' ? 'measurement_job_failed' : 'measurement_pending', status: 'unverified' as const }] };
    }
    assessment.status = state; assessment.traceAssessment = state; assessment.outcomeAssessment = state;
    assessment.semanticAssessment = state; assessment.firstProposalAssessment = state;
    assessment.checks = [{ code: job?.status === 'exhausted' ? 'measurement_job_failed' : 'measurement_pending', status: 'unverified' }];
    assessment.facts.contractPassed = false; assessment.facts.mutationAcks.verified = 0; assessment.facts.latency.censored = true;
    assessment.facts.predicates.confirmed = 0;
    for (const quality of Object.values(assessment.facts.quality)) {
      quality.firstProposalAssessment = state; quality.selectedPlanAssessment = state;
    }
    assessment.claimFacts.classifications = assessment.claimFacts.classifications.map(claim => ({
      ...claim, outcome: 'unverified', evidenceRefs: [], gaps: ['measurement_pending'] }));
    assessment.claimFacts.outcomeContradictedCompletionClaims = [];
    assessment.claimFacts.falseCompletion = [...assessment.claimFacts.prematureSuccessClaims];
    return assessment;
  });
  return { schemaVersion: 2 as const, evaluatorVersion: EVALUATOR_V2_VERSION, generatedAtMs: nowMs, assessments };
}
