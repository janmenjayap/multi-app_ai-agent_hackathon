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
