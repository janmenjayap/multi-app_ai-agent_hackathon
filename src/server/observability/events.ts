import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RunEventViewSchema, assertPublicProjection, type RunEventView } from '../../shared/api.js';
import { immutable, RestrictedArtifactRefSchema, type RestrictedArtifactRef } from '../../shared/domain.js';
import { EventV2Schema, type EventV2 } from '../../shared/events.js';
import { assertNoSecrets } from './redaction.js';

type EnvelopeKey = 'schemaVersion' | 'producerVersion' | 'producerId' | 'eventId' | 'runId' |
  'evaluationAttemptId' | 'runtimeAttemptId' | 'sequence' | 'stage' | 'spanId' | 'parentSpanId' |
  'at' | 'processId' | 'bootId' | 'monotonicMs' | 'causedBy';
export type EventContext = Pick<EventV2, 'producerVersion' | 'producerId' | 'runId' |
  'evaluationAttemptId' | 'runtimeAttemptId' | 'stage' | 'spanId' | 'parentSpanId' | 'causedBy'>;
type Payload<T> = T extends EventV2 ? Omit<T, EnvelopeKey> : never;
export type EventPayload = Payload<EventV2>;
export type EventStamp = Pick<EventV2, 'eventId' | 'at' | 'processId' | 'bootId' | 'monotonicMs'>;

// One identity per process incarnation; PID reuse after restart cannot join clocks.
const PROCESS_ID = `process-${process.pid}`;
const BOOT_ID = `boot-${randomUUID()}`;

export function createEventClock(): { stamp(): EventStamp } {
  return { stamp: () => ({ eventId: randomUUID(), at: new Date().toISOString(),
    processId: PROCESS_ID, bootId: BOOT_ID, monotonicMs: performance.now() }) };
}
const eventClock = createEventClock();

/** Registry validation is strict; raw exception strings never become audit errors. */
export function parseCanonicalEvent(value: unknown, knownSecrets: readonly string[] = []): EventV2 {
  assertNoSecrets(value, knownSecrets);
  const parsed = EventV2Schema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_canonical_event');
  return immutable(parsed.data);
}

/** The repository allocates sequence inside its state/event/job transaction. */
export function createCanonicalEvent(input: {
  context: EventContext;
  payload: EventPayload;
  sequence: number;
  stamp?: EventStamp;
  knownSecrets?: readonly string[];
}): EventV2 {
  return parseCanonicalEvent({ ...input.payload, ...input.context, ...(input.stamp ?? eventClock.stamp()),
    schemaVersion: 2, sequence: input.sequence }, input.knownSecrets);
}

/** Used by the transaction owner to bind every receipt to stored restricted bytes. */
export function collectArtifactReferences(event: EventV2): RestrictedArtifactRef[] {
  const refs: RestrictedArtifactRef[] = [];
  const visit = (value: unknown): void => {
    const ref = RestrictedArtifactRefSchema.safeParse(value);
    if (ref.success) { refs.push(ref.data); return; }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(event);
  return refs;
}

/** Public timeline projection. Evidence links require B04's per-reference authorization. */
export function toPublicEvent(value: unknown, knownSecrets: readonly string[] = []): RunEventView {
  const event = parseCanonicalEvent(value, knownSecrets);
  const result = RunEventViewSchema.parse({ eventId: event.eventId, sequence: event.sequence,
    stageId: event.stage, kind: event.kind, at: event.at, reference: null });
  assertPublicProjection(result);
  return immutable(result);
}
