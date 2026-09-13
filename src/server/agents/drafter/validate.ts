import { DraftInputSchema, parseDraftProposal, parseIncidentAssessment,
  type DraftInput, type DraftProposal } from '../../../shared/agents.js';
import { immutable } from '../../../shared/domain.js';

export const DRAFTER_VALIDATION_VERSION = 'drafter-validation-v1';
export const DRAFTER_NEXT_STEP = 'We will share verified updates when available.';

/** Validate the frozen upstream projection; source text never supplies authority. */
export function validateDrafterInput(value: unknown): DraftInput {
  const input = DraftInputSchema.parse(value);
  if (new Set(input.sources.map(source => source.factId)).size !== input.sources.length)
    throw new Error('duplicate_source_fact');
  parseIncidentAssessment(input.assessment, input.sources);
  if (!input.assessment.facts.length) throw new Error('drafter_impact_evidence_missing');
  return immutable(input);
}

/** Review input only: these requirements are not independent semantic labels. */
export function buildRequiredContentChecklist(input: DraftInput) {
  const checked = validateDrafterInput(input);
  const uncertainty = checked.assessment.unknowns.length ? checked.assessment.unknowns :
    checked.assessment.candidateChange.status !== 'supported' ? [checked.assessment.candidateChange.reason] : [];
  return immutable(checked.commitments.map(commitment => ({
    commitmentId: commitment.commitmentId,
    impact: checked.assessment.facts,
    customerContext: commitment.customerContext,
    promise: commitment.promise,
    uncertainty,
    contradictions: checked.assessment.contradictions.map(contradiction => contradiction.reason),
    nextStep: DRAFTER_NEXT_STEP,
  })));
}

function normalized(text: string): string {
  return text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const authorityInstructions = /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instructions?|system|policy|approval|rules?)\b|\b(?:change|replace|reassign|set|add)\b.{0,30}\b(?:recipient|mailbox|owner|action type|approval)\b|\b(?:send|delete)\s+(?:this\s+|the\s+)?(?:email|message|draft)\b/i;
const falseAuthority = /\b(?:approval (?:has been|is) (?:granted|received)|(?:customer|recipient) (?:has been|was|is) notified|(?:email|message|draft) (?:has been|was|is) sent)\b/i;
const temporalExpression = /\b(?:\d{4}-\d{2}-\d{2}(?:t[\d:.]+z)?|\d{1,2}[/:]\d{1,2}(?:[/:]\d{2,4})?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?|(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d+\s+(?:minutes?|hours?|days?|weeks?))\b/gi;

function unsupportedDates(text: string, supported: readonly string[]): boolean {
  const evidence = normalized(supported.join(' '));
  return [...text.matchAll(temporalExpression)].some(match => !evidence.includes(normalized(match[0])));
}

/**
 * A deliberately conservative content gate for the bounded prototype. Factual
 * claims quote complete SourceFact.text values, preserving negation/attribution;
 * free paraphrases require later independently reviewed semantic support. This
 * check never claims that the original evidence itself is true or complete.
 * It returns the original bytes unchanged; A01 retains failures and corrections.
 */
export function validateDraftProposal(value: unknown, input: DraftInput): DraftProposal {
  const checked = validateDrafterInput(input);
  const proposal = parseDraftProposal(value, checked.commitments.map(commitment => commitment.commitmentId),
    checked.sources.map(source => source.factId));
  const requirements = buildRequiredContentChecklist(checked);
  const sources = new Map(checked.sources.map(source => [source.factId, source]));
  const assessedSourceIds = new Set(checked.assessment.facts.flatMap(fact => fact.sourceFactIds));

  for (const entry of proposal.entries) {
    const required = requirements.find(item => item.commitmentId === entry.commitmentId)!;
    const body = normalized(entry.text);
    const nonImpactText = [required.customerContext, required.promise, ...required.uncertainty,
      ...required.contradictions, required.nextStep].map(normalized);
    const impactSourceIds = new Set(required.impact.filter(fact => !nonImpactText.includes(normalized(fact.text)))
      .flatMap(fact => fact.sourceFactIds));
    if (authorityInstructions.test(entry.text) || falseAuthority.test(entry.text))
      throw new Error('drafter_authority_claim');
    if (!entry.claims.length) throw new Error('drafter_claims_missing');
    if (!body.includes(normalized(required.promise)) ||
        (required.customerContext.trim() && !body.includes(normalized(required.customerContext))))
      throw new Error('drafter_commitment_context_missing');
    if (required.uncertainty.some(text => !body.includes(normalized(text))))
      throw new Error('drafter_uncertainty_missing');
    if (required.contradictions.some(text => !body.includes(normalized(text))))
      throw new Error('drafter_contradiction_missing');
    if (!body.includes(normalized(required.nextStep))) throw new Error('drafter_next_step_missing');

    for (const claim of entry.claims) {
      if (new Set(claim.sourceFactIds).size !== claim.sourceFactIds.length)
        throw new Error('drafter_duplicate_citation');
      const claimText = normalized(claim.text);
      if (!body.includes(claimText)) throw new Error('drafter_claim_not_in_text');
      // Matching a full source fact prevents a quote from stripping "not",
      // "unconfirmed", attribution, or a conflicting qualifier from the source.
      if (claim.sourceFactIds.some(id => normalized(sources.get(id)!.text) !== claimText))
        throw new Error('drafter_unsupported_claim');
      // The original source bundle remains available for independent review,
      // but citing it alone cannot adopt a new factual assertion. In particular,
      // unrelated customer data or injected action claims must not enter a draft.
      if (!nonImpactText.includes(claimText) && claim.sourceFactIds.some(id => !assessedSourceIds.has(id)))
        throw new Error('drafter_unassessed_claim');
      for (const other of checked.commitments) {
        if (other.commitmentId === entry.commitmentId || !other.customerContext.trim() ||
            normalized(other.customerContext) === normalized(required.customerContext)) continue;
        if (claimText.includes(normalized(other.customerContext)))
          throw new Error('drafter_customer_scope_mismatch');
      }
    }
    if (!entry.claims.some(claim => claim.sourceFactIds.some(id => impactSourceIds.has(id))))
      throw new Error('drafter_impact_missing');

    const allowedText = [...entry.claims.map(claim => claim.text), required.customerContext, required.promise,
      ...required.uncertainty, ...required.contradictions, required.nextStep].filter(text => text.trim());
    if (unsupportedDates(entry.text, allowedText)) throw new Error('drafter_unsupported_date');
    // Inspect the entire customer text, not just the model's chosen claim list.
    // Otherwise an invented ETA/extra customer could hide in an uncited clause.
    let remainder = body;
    for (const text of allowedText.map(normalized).sort((a, b) => b.length - a.length))
      remainder = remainder.split(text).join(' ');
    remainder = remainder.replace(/\b(?:hello|hi|dear|thank you|thanks|best regards|regards)\b/g, '')
      .replace(/[\s.,!?;:'"()[\]{}\-–—]/g, '');
    if (remainder) throw new Error('drafter_ungrounded_text');
  }
  return proposal;
}
