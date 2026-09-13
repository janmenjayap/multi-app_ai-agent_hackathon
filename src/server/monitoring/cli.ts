import { readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MonitorStore } from '../storage/monitor-store.js';
import { buildFixture } from './demo.js';
import { processJobs, readReport } from './worker.js';

const LIMIT=2*1024*1024;
const ERRORS=new Set(['invalid_identifier','invalid_manifest','invalid_observation_batch','invalid_time','invalid_lease','invalid_evidence','invalid_assessment',
  'attempt_not_found','attempt_conflict','cohort_version_conflict','event_conflict','event_sequence_invalid','event_time_invalid','label_conflict','trace_sealed',
  'stale_job_lease','store_closed','store_failure','unsupported_store_version','invalid_command','invalid_json_file']);
function readJson(file:string|undefined):unknown {
  try{if(!file||statSync(file).size>LIMIT)throw new Error();const b=readFileSync(file);if(b.length>LIMIT)throw new Error();return JSON.parse(b.toString('utf8'));}
  catch{throw new Error('invalid_json_file');}
}
function required(value:string|undefined):string{if(!value)throw new Error('invalid_command');return value;}
const help={usage:[
  'npm run monitor -- demo [--db .local/reliability.sqlite]',
  'npm run monitor -- export-demo --dir .local/sample',
  'npm run monitor -- register --manifest FILE --attempt ID --run ID [--started-at ISO] [--db FILE]',
  'npm run monitor -- append --attempt ID --input FILE [--db FILE]',
  'npm run monitor -- measure [--db FILE]',
  'npm run monitor -- report [--db FILE]',
  'npm run monitor -- trace --attempt ID [--db FILE]',
],scope:'Offline monitoring of supplied evidence. Does not invoke agents or providers.'};

export function main(args=process.argv.slice(2)):number {
  let store:MonitorStore|undefined;
  const output=(value:unknown)=>process.stdout.write(`${JSON.stringify(value,null,2)}\n`);
  try{
    const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{db:{type:'string'},manifest:{type:'string'},attempt:{type:'string'},run:{type:'string'},input:{type:'string'},'started-at':{type:'string'},dir:{type:'string'},help:{type:'boolean'}}});
    const command=positionals[0];
    if(values.help||!command){output(help);return 0;}
    if(positionals.length!==1||!['demo','export-demo','register','append','measure','report','trace'].includes(command))throw new Error('invalid_command');
    if(command==='export-demo'){
      const dir=resolve(required(values.dir));mkdirSync(dir,{recursive:true,mode:0o700});
      const {record,manifest}=buildFixture();
      writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
      writeFileSync(resolve(dir,'observations.json'),JSON.stringify({events:record.events,evidence:record.evidence,labels:record.labels,traceComplete:true},null,2)+'\n',{mode:0o600,flag:'wx'});
      output({status:'exported',mode:'synthetic_fixture',startedAt:new Date(record.startedAtMs).toISOString()});return 0;
    }
    const db=resolve(values.db??'.local/reliability.sqlite');mkdirSync(dirname(db),{recursive:true,mode:0o700});store=new MonitorStore(db);
    if(command==='register'){
      const startedAt=values['started-at']?Date.parse(values['started-at']):Date.now();
      const r=store.register(required(values.attempt),required(values.run),readJson(values.manifest),startedAt);
      output({status:'registered',evaluationAttemptId:r.evaluationAttemptId,watermark:r.watermark});
    }else if(command==='append'){
      const r=store.append(required(values.attempt),readJson(values.input));
      output({status:'queued',evaluationAttemptId:r.evaluationAttemptId,watermark:r.watermark});
    }else if(command==='measure'){
      const result=processJobs(store);output(result);return result.failed||result.exhausted?1:0;
    }else if(command==='trace'){
      const r=store.getAttempt(required(values.attempt));
      output({evaluationAttemptId:r.evaluationAttemptId,watermark:r.watermark,traceComplete:r.traceComplete,events:r.events});
    }else if(command==='demo'){
      const {manifest,record}=buildFixture();
      store.register(record.evaluationAttemptId,record.runId,manifest,record.startedAtMs);
      store.append(record.evaluationAttemptId,{events:record.events,evidence:record.evidence,labels:record.labels,traceComplete:true});
      const result=processJobs(store);const report=readReport(store);output({demonstration:'synthetic_monitor_only',worker:result,report});
      return result.failed||result.exhausted||store.listAssessments().find(a=>a.evaluationAttemptId===record.evaluationAttemptId)?.status!=='passed'?1:0;
    }else output(readReport(store));
    return 0;
  }catch(error){
    output({status:'error',code:error instanceof Error&&ERRORS.has(error.message)?error.message:'invalid_command_or_operation'});return 2;
  }finally{try{store?.close();}catch{/* Do not expose filesystem or database error text. */}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=main();
