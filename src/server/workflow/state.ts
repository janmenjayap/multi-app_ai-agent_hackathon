import { z } from 'zod';
import { RunViewSchema, StageViewSchema } from '../../shared/api.js';
import { EvaluationAttemptIdSchema, IdSchema, PIPELINE_STAGE_IDS, RestrictedArtifactRefSchema,
  RunIdSchema, RuntimeAttemptIdSchema, StageIdSchema, UtcTimestampSchema, immutable } from '../../shared/domain.js';

/** Application-owned scheduling receipt. Only IDs go into graph checkpoints. */
export const WorkflowStateSchema = z.object({
  schemaVersion: z.literal(2), runId: RunIdSchema, ownerId: IdSchema,
  evaluationAttemptId: EvaluationAttemptIdSchema, runtimeAttemptId: RuntimeAttemptIdSchema,
  runtimeAttemptIds: z.array(RuntimeAttemptIdSchema).min(1).max(1000),
  commandId: IdSchema, incidentTitle: z.string().max(10000),
  stage: StageIdSchema, spanId: IdSchema, lastEventId: IdSchema,
  bootId: IdSchema.nullable(), spanOpen: z.boolean(), waitId: IdSchema.nullable(),
  deadlineAt: UtcTimestampSchema, stageDeadlineAt: UtcTimestampSchema.nullable(),
  stageTimeoutMs: z.number().int().positive().max(300000),
  wakeAt: UtcTimestampSchema.nullable(), scheduleStatus: z.enum(['queued', 'running', 'waiting', 'stopped']),
  statusReason: IdSchema.nullable(),
  stages: z.array(StageViewSchema).length(PIPELINE_STAGE_IDS.length),
  commitments: RunViewSchema.shape.commitments, plan: RunViewSchema.shape.plan,
  approval: RunViewSchema.shape.approval, effects: RunViewSchema.shape.effects,
  verifiedAt: UtcTimestampSchema.nullable(),
  references: z.record(IdSchema, RestrictedArtifactRefSchema),
}).strict().superRefine((v, ctx) => {
  if (v.stages.some((stage, index) => stage.stageId !== PIPELINE_STAGE_IDS[index]) ||
      !v.runtimeAttemptIds.includes(v.runtimeAttemptId) || new Set(v.runtimeAttemptIds).size !== v.runtimeAttemptIds.length ||
      (v.scheduleStatus === 'waiting' && (!v.waitId || !v.wakeAt)) ||
      (v.wakeAt && Date.parse(v.wakeAt) > Date.parse(v.deadlineAt)))
    ctx.addIssue({ code: 'custom', message: 'invalid_workflow_schedule' });
});
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export const WorkflowProjectionPatchSchema = z.object({ commitments: RunViewSchema.shape.commitments.optional(),
  plan: RunViewSchema.shape.plan.optional(), approval: RunViewSchema.shape.approval.optional(),
  effects: RunViewSchema.shape.effects.optional(), references: WorkflowStateSchema.shape.references.optional() }).strict();
export type WorkflowProjectionPatch = z.infer<typeof WorkflowProjectionPatchSchema>;
export function parseWorkflowState(value: unknown): WorkflowState {
  return immutable(WorkflowStateSchema.parse(value));
}
