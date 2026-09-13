import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixture } from './fixture.mjs';
import { parseManifest, parseBatch } from '../../dist/shared/reliability.js';
import { assess } from '../../dist/server/monitoring/assess.js';
import { summarize } from '../../dist/server/evaluations/metrics.js';

test('a completed manifest cannot downgrade its artifact contract to a Slack-only checkpoint',()=>{
  const {manifest}=buildFixture();manifest.family=5;manifest.contract='checkpoint';
  manifest.expected.effects=manifest.expected.effects.filter(e=>e.app==='slack');
  assert.throws(()=>parseManifest(manifest),/invalid_manifest/);
});

for(const defect of ['missing-note','null-owner','invalid-date','extra-To','extra-Cc']){
  test(`frozen S1 manifest rejects ${defect} even before evidence is supplied`,()=>{
    const {manifest}=buildFixture();
    const effect=kind=>manifest.expected.effects.find(e=>e.kind===kind);
    if(defect==='missing-note')manifest.expected.effects=manifest.expected.effects.filter(e=>e.kind!=='note');
    if(defect==='null-owner')effect('task').requiredFields.ownerId=null;
    if(defect==='invalid-date')effect('task').requiredFields.dueAt='sometime';
    if(defect==='extra-To')effect('draft').requiredFields.to='one@example.test,two@example.test';
    if(defect==='extra-Cc')effect('draft').requiredFields.cc=['two@example.test'];
    assert.throws(()=>parseManifest(manifest),/invalid_manifest/);
  });
}

test('trace input rejects raw private text and dispatch without logical retry identity',()=>{
  const {record}=buildFixture();const dispatch=record.events.find(e=>e.kind==='tool.dispatch');
  assert.throws(()=>parseBatch({events:[{...dispatch,rawBody:'PRIVATE-CUSTOMER-TEXT'}]}),/invalid_observation_batch/);
  delete dispatch.logicalCallId;
  assert.throws(()=>parseBatch({events:[dispatch]}),/invalid_observation_batch/);
});

test('successful final artifacts can pass M1 while an invalid first model proposal still fails M7',()=>{
  const {record}=buildFixture();
  const analyst=record.events.find(e=>e.kind==='model.proposal'&&e.role==='analyst');
  record.events.unshift({...analyst,eventId:'invalid-first-analyst',valid:false,artifactRef:'invalid-first-output'});
  record.events.forEach((e,i)=>{e.sequence=i+1;e.atMs=record.startedAtMs+(i+1)*100;});
  record.labels.push({labelId:'invalid-first-label',proposalEventId:'invalid-first-analyst',role:'analyst',reviewerKind:'human',grounding:false,completeness:false,decision:false,handoff:false});
  const assessment=assess(record,record.events.at(-1).atMs+1);
  assert.equal(assessment.status,'passed');
  assert.equal(assessment.semanticAssessment,'passed');
  assert.equal(assessment.firstProposalAssessment,'failed');
  const {metrics}=summarize([assessment]).groups[0];
  assert.equal(metrics.M1.numerator,1);assert.equal(metrics.M1.denominator,1);
  assert.equal(metrics.M7.analyst.numerator,0);assert.equal(metrics.M7.analyst.denominator,1);
});
