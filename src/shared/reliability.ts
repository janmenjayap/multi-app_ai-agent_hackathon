import { createHash } from 'node:crypto';
import { z } from 'zod';

export const EVALUATOR_VERSION = 'monitor-v1';
const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AppSchema = z.enum(['github', 'hubspot', 'slack', 'gmail']);
export const ModeSchema = z.enum(['synthetic_fixture', 'model_with_fake_providers', 'imported_provider_snapshot']);
export const StatusSchema = z.enum(['completed', 'completed_no_affected_commitments', 'awaiting_approval', 'safely_blocked', 'failed_partial', 'failed']);
export const RoleSchema = z.enum(['analyst', 'drafter', 'auditor']);
export const EffectSchema = z.object({
  app: AppSchema, effectKey: id,
  kind: z.enum(['task', 'note', 'draft', 'comment', 'thread']),
  required: z.boolean(), requiredFields: z.record(z.string(), z.json()),
}).strict();

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1), manifestId: id, cohortId: id,
  mode: ModeSchema, family: z.number().int().min(1).max(18),
  contract: z.enum(['promiseguard_s1', 'checkpoint']),
  versions: z.object({ app: id, fixture: id, policy: id, prompt: id, model: id }).strict(),
  executionEligible: z.boolean(), expectedUnsafe: z.boolean(),
  requiredRoles: z.array(RoleSchema).max(3),
  recoveryKind: z.enum(['none', 'read_retry', 'accepted_write']),
  expected: z.object({ terminalStatus: StatusSchema, effects: z.array(EffectSchema).max(100),
    protectedRecords: z.array(z.object({ app: AppSchema, id }).strict()).min(1).max(1000),
  }).strict(),
  budgets: z.object({ activeMs: time.positive(), humanWaitMs: time,
    wallMs: time.positive(), recoveryMs: time.positive(), maxToolAttempts: z.number().int().positive().max(10000),
  }).strict(),
}).strict().superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(m.requiredRoles).size !== m.requiredRoles.length) fail('duplicate_role');
  if (m.executionEligible && (m.expected.terminalStatus!=='completed'||m.expectedUnsafe)) fail('invalid_execution_eligibility');
  const keys = m.expected.effects.map(e => e.effectKey);
  if (new Set(keys).size !== keys.length) fail('duplicate_effect_key');
  const apps = {task:'hubspot',note:'hubspot',draft:'gmail',comment:'github',thread:'slack'};
  for (const e of m.expected.effects) {
    if (e.app !== apps[e.kind]) fail('effect_kind_app_mismatch');
    if (!Object.keys(e.requiredFields).length) fail('empty_fields');
    if (e.kind === 'draft') {
      const f = e.requiredFields;
      if (!z.email().safeParse(f.to).success || !hash.safeParse(f.bodySha256).success ||
        typeof f.subject !== 'string' || !f.subject || f.isDraft !== true ||
        !Array.isArray(f.cc) || f.cc.length || !Array.isArray(f.bcc) || f.bcc.length) fail('invalid_draft_contract');
    }
  }
  if (m.family === 1 && m.contract !== 'promiseguard_s1') fail('golden_requires_s1_contract');
  if (m.expected.terminalStatus==='completed' && m.contract!=='promiseguard_s1') fail('completion_requires_full_artifact_contract');
  if (m.contract === 'promiseguard_s1') {
    if (!m.executionEligible || m.expected.terminalStatus !== 'completed' || m.expectedUnsafe) fail('invalid_s1_status');
    if(m.family===1)for (const role of ['analyst','drafter','auditor']) if (!m.requiredRoles.includes(role as Role)) fail('s1_missing_role');
    const fields: Record<string,string[]> = {
      task:['companyId','commitmentId','ownerId','dueAt','status'], note:['companyId','commitmentId','taskId','bodySha256'],
      draft:['to','cc','bcc','subject','bodySha256','isDraft'],
      comment:['incidentId','commitmentId','hubspotTaskId','gmailDraftId','bodySha256'],
      thread:['channelId','githubCommentId','hubspotTaskId','hubspotNoteId','gmailDraftId','verdict'],
    };
    for (const [kind, required] of Object.entries(fields)) {
      const es=m.expected.effects.filter(e=>e.kind===kind && e.required);
      if (!es.length || es.some(e=>required.some(f=>!Object.hasOwn(e.requiredFields,f)))) fail('incomplete_s1_contract');
      for (const e of es) for (const f of required) {
        if (['cc','bcc','isDraft'].includes(f)) continue;
        if (typeof e.requiredFields[f] !== 'string' || !e.requiredFields[f]) fail('invalid_s1_field');
        if (f==='bodySha256' && !hash.safeParse(e.requiredFields[f]).success) fail('invalid_body_hash');
        if (f==='dueAt' && !z.iso.datetime({offset:true}).safeParse(e.requiredFields[f]).success) fail('invalid_due_at');
      }
    }
    if (!m.expected.protectedRecords.some(p=>p.app==='hubspot')) fail('s1_missing_protected_crm');
  }
});

const base = { eventId: id, sequence: z.number().int().positive(), runtimeAttemptId: id, atMs: time };
const event = <T extends z.ZodRawShape>(shape: T) => z.object({...base,...shape}).strict();
export const EventSchema = z.discriminatedUnion('kind', [
  event({kind:z.literal('plan.frozen'),planHash:hash,requests:z.array(z.object({effectKey:id,requestHash:hash}).strict()).max(100)}),
  event({kind:z.literal('approval.checked'),approvalId:id,planHash:hash,authorized:z.boolean(),decision:z.enum(['approved','rejected']),expiresAtMs:time,sourceEvidenceRef:id}),
  event({kind:z.literal('sources.checked'),planHash:hash,complete:z.boolean(),freshUntilMs:time,sourceEvidenceRef:id}),
  event({kind:z.literal('tool.dispatch'),providerAttemptId:id,logicalCallId:id,actor:z.enum(['executor','verifier','coordinator']),app:AppSchema,
    operation:z.enum(['read','create','update','send','delete','production_mutation']),effectKey:id.optional(),planHash:hash.optional(),requestHash:hash.optional(),approvalId:id.optional(),coordinationPhase:z.enum(['review','summary']).optional()}),
  event({kind:z.literal('tool.result'),providerAttemptId:id,outcome:z.enum(['success','error','unknown']),providerId:id.optional()}),
  event({kind:z.literal('effect.reconciled'),effectKey:id,resolution:z.enum(['adopted','not_applied','unresolved','conflict']),providerId:id.optional(),readAttemptId:id}),
  event({kind:z.literal('effect.verified'),effectKey:id,providerId:id,readAttemptId:id,matches:z.boolean(),planHash:hash,purpose:z.enum(['review','effect']).default('effect')}),
  event({kind:z.literal('model.proposal'),role:RoleSchema,revision:z.number().int().positive(),valid:z.boolean(),artifactRef:id}),
  event({kind:z.literal('wait.started'),waitId:id}), event({kind:z.literal('wait.ended'),waitId:id}),
  event({kind:z.literal('recovery.started')}),
  event({kind:z.literal('run.status'),status:StatusSchema}),
  event({kind:z.literal('success.claimed'),scope:z.enum(['artifacts','run'])}),
]);
const labelValue=z.union([z.boolean(),z.literal('uncertain')]);
export const LabelSchema=z.object({labelId:id,proposalEventId:id,role:RoleSchema,reviewerKind:z.enum(['human','model']),
  grounding:labelValue,completeness:labelValue,decision:labelValue,handoff:labelValue,
}).strict();
export const BatchSchema=z.object({events:z.array(EventSchema).max(10000).default([]),
  evidence:z.unknown().optional(),labels:z.array(LabelSchema).max(1000).default([]),traceComplete:z.boolean().optional(),
}).strict();

export type Manifest=z.infer<typeof ManifestSchema>;
export type MonitorEvent=z.infer<typeof EventSchema>;
export type SemanticLabel=z.infer<typeof LabelSchema>;
export type ObservationBatch=z.infer<typeof BatchSchema>;
export type Mode=z.infer<typeof ModeSchema>;
export type Role=z.infer<typeof RoleSchema>;
export type App=z.infer<typeof AppSchema>;
export type ProductStatus=z.infer<typeof StatusSchema>;
export type Verdict='pending'|'unverified'|'passed'|'failed';
export interface AttemptRecord {
  evaluationAttemptId:string; runId:string; manifest:Manifest; startedAtMs:number;
  events:MonitorEvent[]; evidence:unknown|null; labels:SemanticLabel[]; traceComplete:boolean; watermark:number;
}
export interface Check { code:string; status:Exclude<Verdict,'pending'>; eventSequence?:number; effectIndex?:number }
export interface AttemptFacts {
  executionEligible:boolean; contractPassed:boolean; expectedUnsafe:boolean; safelyBlocked:boolean;
  tools:{dispatched:number; succeeded:number; firstDispatched:number; firstSucceeded:number; byApp:Record<string,{dispatched:number;succeeded:number;firstDispatched:number;firstSucceeded:number}>};
  predicates:{required:number;confirmed:number}; mutationAcks:{total:number;verified:number};
  recovery:{kind:Manifest['recoveryKind'];eligible:boolean;passed:boolean};
  creations:{applied:number;excess:number};
  latency:{wallMs:number;waitMs:number;activeMs:number;censored:boolean};
  quality:Partial<Record<Role,{required:boolean;passed:boolean}>>;
  critical:{forbiddenOperations:number;approvalBypasses:number;incorrectRecipients:number;unsupportedClaims:number;falseCompletion:number;successClaims:number};
}
export interface Assessment {
  schemaVersion:1; evaluatorVersion:string; evaluationAttemptId:string;runId:string;cohortId:string;mode:Mode;versions:Manifest['versions'];
  watermark:number;observedAtMs:number;productStatus:ProductStatus|null;
  traceCoverage:'complete'|'incomplete';traceAssessment:Verdict;outcomeAssessment:Verdict;semanticAssessment:Verdict;status:Verdict;
  firstProposalAssessment?:Verdict;
  checks:Check[];facts:AttemptFacts;
}

export function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value!==null && typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value:unknown):string {return createHash('sha256').update(canonical(value)).digest('hex');}
export function parseManifest(value:unknown):Manifest {
  const parsed=ManifestSchema.safeParse(value);if(!parsed.success)throw new Error('invalid_manifest');return parsed.data;
}
export function parseBatch(value:unknown):ObservationBatch {
  const parsed=BatchSchema.safeParse(value);if(!parsed.success)throw new Error('invalid_observation_batch');return parsed.data;
}
export function assertId(value:string):void {if(!id.safeParse(value).success)throw new Error('invalid_identifier');}
