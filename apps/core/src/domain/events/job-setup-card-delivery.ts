export type JobSetupCardDeliveryOutcome =
  | 'delivered'
  | 'ambiguous'
  | 'exhausted'
  | 'cancelled'
  | 'expired';

export interface JobSetupCardDeliveryEventPayload {
  prompt_id: string;
  generation: number;
  job_id: string;
  setup_fingerprint: string;
  outcome: JobSetupCardDeliveryOutcome;
  attempt: number;
  provider: string;
  detail?: string;
}

const OUTCOMES = new Set<JobSetupCardDeliveryOutcome>([
  'delivered',
  'ambiguous',
  'exhausted',
  'cancelled',
  'expired',
]);

export function jobSetupCardDeliveryEventPayload(
  input: JobSetupCardDeliveryEventPayload,
): JobSetupCardDeliveryEventPayload {
  return input;
}

export function parseJobSetupCardDeliveryEventPayload(
  value: unknown,
): JobSetupCardDeliveryEventPayload | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const payload = parsed as Record<string, unknown>;
  const allowedKeys = new Set([
    'prompt_id',
    'generation',
    'job_id',
    'setup_fingerprint',
    'outcome',
    'attempt',
    'provider',
    'detail',
  ]);
  if (!Object.keys(payload).every((key) => allowedKeys.has(key))) return null;
  if (
    !nonEmptyString(payload.prompt_id) ||
    !positiveInteger(payload.generation) ||
    !nonEmptyString(payload.job_id) ||
    !nonEmptyString(payload.setup_fingerprint) ||
    !OUTCOMES.has(payload.outcome as JobSetupCardDeliveryOutcome) ||
    !nonNegativeInteger(payload.attempt) ||
    !nonEmptyString(payload.provider) ||
    (payload.detail !== undefined && typeof payload.detail !== 'string')
  ) {
    return null;
  }
  return payload as unknown as JobSetupCardDeliveryEventPayload;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
