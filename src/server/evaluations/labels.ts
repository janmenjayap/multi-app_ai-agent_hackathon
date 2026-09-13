import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { AuditVerdictSchema, DraftProposalSchema, IncidentAssessmentSchema, roleInvocationKey } from '../../shared/agents.js';
import { IdSchema, RestrictedArtifactRefSchema, RoleSchema, RunIdSchema, canonical, immutable,
  type RestrictedArtifactRef } from '../../shared/domain.js';
import { ReviewLabelSchema, parseReviewLabel, type OriginalOutput, type ReviewLabel } from '../../shared/evaluation.js';
import { digest } from '../../shared/reliability.js';
import { createEventClock } from '../observability/events.js';
import type { ApplicationRepository } from '../storage/repositories.js';

const issuedReviews = new Set<string>();
const valueSchema = z.union([z.boolean(), z.literal('uncertain')]);
const judgmentSchema = z.enum(['supported', 'unsupported', 'uncertain']);
const reasonSchema = z.string().trim().min(1).max(4000);
const sourceFieldSchema = z.object({ sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceField: z.string().trim().min(1).max(300) }).strict();
const requiredContentSchema = z.object({ requirementId: IdSchema,
  judgment: z.enum(['present', 'missing', 'uncertain']), reason: reasonSchema }).strict();

export interface OriginalReviewPacket {
  original: OriginalOutput;
  rawOutput: string;
  sourceBundleRef: RestrictedArtifactRef;
  sourceBundle: string;
  sources: { ref: RestrictedArtifactRef; content: string }[];
  claims: { claimId: string; text: string }[];
}

/** Only immutable original inputs/outputs are loaded; no selected plan or edited answer is shown. */
export function loadOriginalReviewPacket(repository: ApplicationRepository, input: {
  runId: string; planRevision: number; role: OriginalOutput['role']; outputId?: string;
}): OriginalReviewPacket | null {
  const key = roleInvocationKey(input.runId, input.planRevision, input.role);
  const outputs = repository.listOutputs(key);
  const original = input.outputId ? outputs.find(output => output.outputId === input.outputId) : outputs[0];
  if (!original) {
    if (input.outputId) throw new Error('review_output_missing');
    return null;
  }
  const role = repository.getRole(key);
  if (!role || role.context.inputDigest !== original.inputDigest || role.context.configDigest !== original.configDigest)
    throw new Error('review_original_context_mismatch');
  const rawOutput = repository.readArtifact(original.rawOutput);
  const sourceBundleRef = role.context.snapshotBundleRef;
  const sourceBundle = repository.readArtifact(sourceBundleRef);
  const references = new Map<string, RestrictedArtifactRef>();
  const visit = (value: unknown): void => {
    const ref = RestrictedArtifactRefSchema.safeParse(value);
    if (ref.success) { references.set(ref.data.sha256, ref.data); return; }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(JSON.parse(sourceBundle));
  const sources = [...new Set(original.sourceDigests)].map(sourceDigest => {
    const ref = references.get(sourceDigest);
    if (!ref) throw new Error('review_original_source_missing');
    return { ref, content: repository.readArtifact(ref) };
  });
  let claims: OriginalReviewPacket['claims'] = [];
  try {
    const parsed: unknown = JSON.parse(rawOutput);
    if (original.role === 'analyst') claims = IncidentAssessmentSchema.parse(parsed).facts;
    if (original.role === 'drafter') claims = DraftProposalSchema.parse(parsed).entries.flatMap(entry => entry.claims);
    if (original.role === 'auditor') claims = AuditVerdictSchema.parse(parsed).entries.flatMap(entry => entry.findings)
      .map(finding => ({ claimId: finding.claimId, text: `${finding.verdict}: ${finding.reason}` }));
  } catch { /* Malformed and refused originals remain reviewable and stay in M7. */ }
  return immutable({ original, rawOutput, sourceBundleRef, sourceBundle, sources,
    claims: claims.map(({ claimId, text }) => ({ claimId, text })) });
}

export interface ReviewInteraction {
  label: ReviewLabel;
  interactionRef: RestrictedArtifactRef;
  receipt: unknown;
}

/**
 * Rehydration never authenticates serialized reviewerKind/kind text. A deployment can
 * supply its separately authenticated operator/signature boundary; receipt possession
 * or a matching digest alone is not that boundary. Without it old receipts are unverified.
 */
export function createReviewTrust(repository: ApplicationRepository, options: {
  authenticateInteraction?: (interaction: ReviewInteraction) => boolean;
} = {}): (label: ReviewLabel) => boolean {
  return value => {
    try {
      const label = ReviewLabelSchema.parse(value);
      if (label.reviewer.kind !== 'human') return false;
      if (!repository.listReviewLabels(label.outputId).some(stored => canonical(stored) === canonical(label))) return false;
      const interactionRef = label.reviewer.interactionRef;
      const receipt: unknown = JSON.parse(repository.readArtifact(interactionRef));
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
      const record = receipt as Record<string, unknown>;
      if (record.kind === 'interactive_original_review' && record.schemaVersion === 2) {
        const bound = ReviewLabelSchema.parse({ ...(record.label as object), reviewer: label.reviewer });
        if (record.reviewerId !== label.reviewer.reviewerId || canonical(bound) !== canonical(label)) return false;
      } else if (record.kind === 'interactive_terminal_review') {
        // R01's original receipt retains its exact identity and intentionally partial judgments.
        if (record.reviewerId !== label.reviewer.reviewerId || record.outputId !== label.outputId ||
            record.outputDigest !== label.outputDigest || canonical(record.sourceDigests) !== canonical(label.sourceDigests) ||
            record.reviewedAt !== label.reviewedAt || record.reason !== label.reason ||
            !['pass', 'fail'].includes(String(record.answer)) || label.grounding !== (record.answer === 'pass') ||
            label.completeness !== (record.answer === 'pass') || label.decision !== 'uncertain' ||
            label.handoff !== 'uncertain' || label.findings.length || label.supersedesLabelId !== null) return false;
      } else return false;
      return issuedReviews.has(digest(label)) || options.authenticateInteraction?.({ label, interactionRef, receipt }) === true;
    } catch { return false; }
  };
}

/** Actual terminal input is the only built-in issuer. Model/fixture/imported JSON cannot issue trust. */
export async function reviewOriginalOutputs(options: {
  repository: ApplicationRepository;
  runId: string;
  planRevision?: number;
  roles?: OriginalOutput['role'][];
  /** Optional explicit later outputs are reviewed only after all requested first outputs. */
  includeCorrections?: boolean;
}): Promise<{ labels: ReviewLabel[]; isTrustedReview: (label: ReviewLabel) => boolean }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('human_review_requires_interactive_terminal');
  const repository = options.repository;
  const runId = RunIdSchema.parse(options.runId);
  if (!repository.getRun(runId)) throw new Error('review_run_missing');
  const revision = options.planRevision ?? 1;
  const roles = z.array(RoleSchema).min(1).max(3).parse(options.roles ?? ['analyst', 'drafter', 'auditor']);
  if (new Set(roles).size !== roles.length) throw new Error('duplicate_review_role');
  const packets = roles.flatMap(role => {
    const packet = loadOriginalReviewPacket(repository, { runId, planRevision: revision, role });
    return packet ? [packet] : [];
  });
  const firstPackets = [...packets];
  if (options.includeCorrections) for (const first of firstPackets) {
    for (const output of repository.listOutputs(first.original.roleInvocationKey).slice(1)) {
      packets.push(loadOriginalReviewPacket(repository, { runId, planRevision: revision,
        role: output.role, outputId: output.outputId })!);
    }
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async <T>(prompt: string, schema: z.ZodType<T>): Promise<T> => schema.parse((await terminal.question(prompt)).trim());
  const askValue = async (dimension: string): Promise<ReviewLabel['grounding']> => {
    const value = await ask(`${dimension}: pass, fail, or uncertain: `, z.enum(['pass', 'fail', 'uncertain']));
    return valueSchema.parse(value === 'uncertain' ? value : value === 'pass');
  };
  const labels: ReviewLabel[] = [];
  try {
    const reviewerId = await ask('Your reviewer identity: ', IdSchema);
    await ask('Confirm you are a human independently reviewing the original sources (enter human): ', z.literal('human'));
    for (const packet of packets) {
      const { original } = packet;
      process.stdout.write(`\n${original.role} output ${original.outputId}; first output ${original.firstOutputId}\n` +
        `Plan revision ${original.planRevision}; model attempt ${original.modelAttemptId}; ` +
        `${original.parseStatus}/${original.validationStatus}\nOriginal source bundle:\n${packet.sourceBundle}\n`);
      packet.sources.forEach((source, index) => process.stdout.write(`\nSource ${index + 1} ${source.ref.sha256}:\n${source.content}\n`));
      process.stdout.write(`\nUnedited output (${original.rawOutput.sha256}):\n${packet.rawOutput}\n`);
      if (await ask('Review this output or skip (review/skip): ', z.enum(['review', 'skip'])) === 'skip') continue;
      const grounding = await askValue('All factual claims grounded in those sources');
      const completeness = await askValue('All required content present');
      const decision = await askValue('Decision justified by the original evidence');
      const handoff = await askValue('Handoff content satisfies the task');
      const findings: ReviewLabel['findings'] = [];
      const claimSourceFields: { claimId: string; sources: z.infer<typeof sourceFieldSchema>[] }[] = [];
      for (const claim of packet.claims) {
        process.stdout.write(`\nClaim ${claim.claimId}: ${claim.text}\n`);
        const judgment = await ask('Support (supported/unsupported/uncertain): ', judgmentSchema);
        const reason = await ask('Short source-based reason: ', reasonSchema);
        const selected = (await terminal.question('Relevant source numbers, comma separated (blank if none): ')).trim();
        const indexes = selected ? selected.split(',').map(value => z.coerce.number().int().min(1).max(packet.sources.length).parse(value.trim()) - 1) : [];
        if (new Set(indexes).size !== indexes.length || (judgment === 'supported' && !indexes.length))
          throw new Error('review_claim_sources_missing_or_duplicate');
        const sourceFields: z.infer<typeof sourceFieldSchema>[] = [];
        for (const index of indexes) {
          const sourceField = await ask(`Source ${index + 1} field supporting this judgment: `, sourceFieldSchema.shape.sourceField);
          sourceFields.push({ sourceDigest: packet.sources[index].ref.sha256, sourceField });
        }
        findings.push({ claimId: claim.claimId, judgment, reason, sourceDigests: sourceFields.map(source => source.sourceDigest) });
        claimSourceFields.push({ claimId: claim.claimId, sources: sourceFields });
      }
      const requiredContent: z.infer<typeof requiredContentSchema>[] = [];
      while (await ask('Record a required-content finding (yes/no): ', z.enum(['yes', 'no'])) === 'yes') {
        const requirementId = await ask('Required fact or requirement ID: ', IdSchema);
        if (requiredContent.some(item => item.requirementId === requirementId)) throw new Error('duplicate_review_requirement');
        const judgment = await ask('Content (present/missing/uncertain): ', requiredContentSchema.shape.judgment);
        const reason = await ask('Short required-content reason: ', reasonSchema);
        requiredContent.push({ requirementId, judgment, reason });
      }
      const reason = await ask('Overall source-based reason (include any uncertainty): ', reasonSchema);
      const prior = repository.listReviewLabels(original.outputId);
      let supersedesLabelId: string | null = null;
      if (prior.length) {
        process.stdout.write(`Existing labels: ${prior.map(label => label.labelId).join(', ')}\n`);
        const answer = (await terminal.question('Label ID corrected by this review (blank for an independent label): ')).trim();
        if (answer) {
          supersedesLabelId = IdSchema.parse(answer);
          if (!prior.some(label => label.labelId === supersedesLabelId) || prior.some(label => label.supersedesLabelId === supersedesLabelId))
            throw new Error('review_supersedes_current_label_required');
        }
      }
      const reviewedAt = new Date().toISOString();
      const labelFields = { schemaVersion: 2 as const, labelId: randomUUID(), runId,
        evaluationAttemptId: original.evaluationAttemptId, outputId: original.outputId, role: original.role,
        outputDigest: original.rawOutput.sha256, sourceDigests: original.sourceDigests,
        grounding: findings.some(finding => finding.judgment === 'unsupported') ? false :
          findings.some(finding => finding.judgment === 'uncertain') && grounding === true ? 'uncertain' as const : grounding,
        completeness: requiredContent.some(finding => finding.judgment === 'missing') ? false :
          requiredContent.some(finding => finding.judgment === 'uncertain') && completeness === true ? 'uncertain' as const : completeness,
        decision, handoff, findings, reason, reviewedAt, supersedesLabelId };
      const clock = createEventClock();
      const label = repository.transaction({ producerVersion: 'q05-review-v2', producerId: 'operator-review',
        runId, evaluationAttemptId: original.evaluationAttemptId, runtimeAttemptId: original.runtimeAttemptId,
        stage: 'assess', spanId: randomUUID(), parentSpanId: null, causedBy: [] }, writer => {
        writer.appendEvent({ kind: 'stage.started' }, clock.stamp());
        const interactionRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: {
          schemaVersion: 2, kind: 'interactive_original_review', reviewerId, reviewerKind: 'human',
          inputOrigin: 'interactive_terminal', reviewedAt, label: labelFields, firstOutputId: original.firstOutputId,
          previousOutputId: original.previousOutputId, planRevision: original.planRevision, roleInvocationKey: original.roleInvocationKey,
          modelAttemptId: original.modelAttemptId, inputDigest: original.inputDigest, configDigest: original.configDigest,
          sourceBundleRef: packet.sourceBundleRef, claimSourceFields, requiredContent,
          correctionReason: original.correctionReason,
        } });
        const parsed = parseReviewLabel({ ...labelFields, reviewer: { kind: 'human', reviewerId, interactionRef } }, original, prior);
        writer.recordReviewLabel(parsed);
        writer.appendEvent({ kind: 'fault.recorded', faultId: 'human-review-receipt', evidenceRef: interactionRef }, clock.stamp());
        writer.appendEvent({ kind: 'stage.finished', outcome: 'succeeded' }, clock.stamp());
        return parsed;
      });
      issuedReviews.add(digest(label));
      labels.push(label);
    }
    return { labels, isTrustedReview: createReviewTrust(repository) };
  } finally { terminal.close(); }
}
