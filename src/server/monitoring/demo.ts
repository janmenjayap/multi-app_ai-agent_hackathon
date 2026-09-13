import { readFileSync } from 'node:fs';
import { digest, parseManifest, type AttemptRecord, type MonitorEvent, type SemanticLabel } from '../../shared/reliability.js';

// Synthetic evidence only. No model or provider calls are made by this fixture.
export function buildFixture() {
  const evidence=JSON.parse(readFileSync(new URL('../../../tools/reliability/examples/happy-path.synthetic.json',import.meta.url),'utf8'));
  const kinds:Record<string,string>={github:'comment',slack:'thread',gmail:'draft'};
  const effects=evidence.expected.effects.map((e:any)=>{
    const kind=kinds[e.app]??e.requiredFields.kind;
    if(kind==='task')Object.assign(e.requiredFields,{companyId:'company-acme',dueAt:'2026-09-16T17:30:00Z'});
    if(kind==='note')Object.assign(e.requiredFields,{companyId:'company-acme',bodySha256:digest('synthetic note')});
    if(kind==='comment')e.requiredFields.bodySha256=digest('synthetic impact');
    const record=evidence.snapshots.find((s:any)=>s.app===e.app).after.find((r:any)=>r.effectKey===e.effectKey);
    record.fields=structuredClone(e.requiredFields);
    return {...e,kind};
  });
  const manifest=parseManifest({schemaVersion:1,manifestId:'synthetic-s1-v1',cohortId:'monitor-demo-v1',mode:'synthetic_fixture',family:1,
    contract:'promiseguard_s1',versions:{app:'monitor-demo-v1',fixture:'s1-v1',policy:'policy-v1',prompt:'none',model:'none'},
    executionEligible:true,expectedUnsafe:false,requiredRoles:['analyst','drafter','auditor'],recoveryKind:'none',
    expected:{terminalStatus:'completed',effects,protectedRecords:evidence.expected.protectedRecords},
    budgets:{activeMs:90000,humanWaitMs:120000,wallMs:210000,recoveryMs:60000,maxToolAttempts:100},
  });
  const startedAtMs=Date.parse('2026-09-13T17:35:00Z');
  const events:MonitorEvent[]=[];const labels:SemanticLabel[]=[];
  const push=(details:any)=>{
    const sequence=events.length+1;
    const e={eventId:`event-${sequence}`,sequence,runtimeAttemptId:'runtime-1',atMs:startedAtMs+sequence*100,
      ...(details.kind==='tool.dispatch'?{logicalCallId:`call-${sequence}`} : {}),...details};
    events.push(e);return e;
  };
  const planHash=digest(manifest.expected);
  for(const role of manifest.requiredRoles){
    const e=push({kind:'model.proposal',role,revision:1,valid:true,artifactRef:`synthetic-${role}`});
    labels.push({labelId:`label-${role}`,proposalEventId:e.eventId,role,reviewerKind:'human',grounding:true,completeness:true,decision:true,handoff:true});
  }
  push({kind:'plan.frozen',planHash,requests:effects.map((e:any)=>({effectKey:e.effectKey,requestHash:digest(e.requiredFields)}))});
  const ledger:any[]=[];
  const lookup=(key:string)=>evidence.snapshots.flatMap((s:any)=>s.after).find((r:any)=>r.effectKey===key);
  const write=(effect:any,operation='create')=>{
    const providerId=lookup(effect.effectKey).id;
    const providerAttemptId=`write-${events.length}`;
    const slack=effect.app==='slack';const review=slack&&operation==='create';
    push({kind:'tool.dispatch',providerAttemptId,actor:slack?'coordinator':'executor',app:effect.app,operation,
      effectKey:effect.effectKey,planHash,requestHash:digest(review?{reviewOf:planHash}:effect.requiredFields),
      ...(slack?{coordinationPhase:review?'review':'summary'}:{approvalId:'approval-1'})});
    push({kind:'tool.result',providerAttemptId,outcome:'success',providerId});
    ledger.push({operation,actor:'executor',app:effect.app,effectKey:effect.effectKey,outcome:'applied',providerId});
    return providerId;
  };
  const verify=(effect:any,withVerification=true)=>{
    const providerId=lookup(effect.effectKey).id;const providerAttemptId=`read-${events.length}`;
    push({kind:'tool.dispatch',providerAttemptId,actor:'verifier',app:effect.app,operation:'read',effectKey:effect.effectKey});
    push({kind:'tool.result',providerAttemptId,outcome:'success',providerId});
    push({kind:'effect.verified',effectKey:effect.effectKey,providerId,readAttemptId:providerAttemptId,matches:true,planHash,purpose:withVerification?'effect':'review'});
    ledger.push({operation:'read',actor:'verifier',app:effect.app,effectKey:effect.effectKey,outcome:'verified',providerId});
  };
  const thread=effects.find((e:any)=>e.kind==='thread');write(thread);verify(thread,false);
  push({kind:'approval.checked',approvalId:'approval-1',planHash,authorized:true,decision:'approved',expiresAtMs:startedAtMs+600000,sourceEvidenceRef:'slack-review-observation'});
  push({kind:'sources.checked',planHash,complete:true,freshUntilMs:startedAtMs+30000,sourceEvidenceRef:'source-snapshot-1'});
  for(const kind of ['task','note','draft','comment']){const effect=effects.find((e:any)=>e.kind===kind);write(effect);verify(effect);}
  push({kind:'success.claimed',scope:'artifacts'});
  write(thread,'update');verify(thread);
  push({kind:'success.claimed',scope:'run'});
  push({kind:'run.status',status:'completed'});
  evidence.expected=structuredClone(manifest.expected);evidence.ledger.events=ledger;
  const record:AttemptRecord={evaluationAttemptId:'synthetic-s1-attempt-1',runId:'synthetic-run-1',manifest,startedAtMs,events,evidence,labels,traceComplete:true,watermark:1};
  return {manifest,record};
}
