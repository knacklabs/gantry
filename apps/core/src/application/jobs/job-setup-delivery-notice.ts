import type { JobEvent } from '../../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import {
  parseJobSetupCardDeliveryEventPayload,
  type JobSetupCardDeliveryOutcome,
} from '../../domain/events/job-setup-card-delivery.js';

export interface JobSetupDeliveryNotice {
  outcome: JobSetupCardDeliveryOutcome;
  attempt: number;
  text: string;
}

export function setupDeliveryNoticeFromEvents(input: {
  events: readonly JobEvent[];
  setupFingerprint: string | null | undefined;
  // The job's live (open/claimed) prompt, when known. Expiry/resume keeps
  // the fingerprint but issues a NEW prompt row, so a fingerprint-only
  // match would keep showing the retired prompt's terminal notice.
  activePromptId?: string | null;
}): JobSetupDeliveryNotice | null {
  if (!input.setupFingerprint) return null;
  // Select the latest matching event explicitly - callers are not required
  // to pre-sort.
  let latest:
    | {
        event: JobEvent;
        payload: {
          outcome: JobSetupCardDeliveryOutcome;
          attempt: number;
          generation: number;
        };
      }
    | null = null;
  for (const event of input.events) {
    if (event.event_type !== RUNTIME_EVENT_TYPES.JOB_SETUP_CARD_DELIVERY) {
      continue;
    }
    const payload = parseJobSetupCardDeliveryEventPayload(event.payload);
    if (payload?.setup_fingerprint !== input.setupFingerprint) continue;
    if (input.activePromptId && payload.prompt_id !== input.activePromptId) {
      // The latest prompt's own outcomes are the current story. No event
      // yet means no notice - the fresh delivery has nothing to report.
      continue;
    }
    if (!latest || rank(payload, event) > rank(latest.payload, latest.event)) {
      latest = { event, payload };
    }
  }
  if (!latest) return null;
  return {
    outcome: latest.payload.outcome,
    attempt: latest.payload.attempt,
    text: formatSetupDeliveryNotice(latest.payload.outcome),
  };
}

// Precedence: Axis-B expiry beats everything (a post-expiry 'delivered'
// settle is truthful about the send but the card is inactive), then the
// NEWEST delivery generation (an old generation may reconcile late with a
// higher event id), then event order within a generation.
function rank(
  payload: { outcome: JobSetupCardDeliveryOutcome; generation: number },
  event: JobEvent,
): number {
  const ordinal =
    typeof event.id === 'number'
      ? event.id
      : Date.parse(event.created_at ?? '') || 0;
  if (payload.outcome === 'expired') return Number.MAX_SAFE_INTEGER;
  return payload.generation * 2 ** 40 + ordinal;
}

export function formatSetupDeliveryNotice(
  outcome: JobSetupCardDeliveryOutcome,
): string {
  if (outcome === 'delivered') {
    return 'The approval prompt was delivered.';
  }
  if (outcome === 'ambiguous') {
    return 'A prompt may have been sent but could not be confirmed. Tap it if you got it, or approve from the pending list.';
  }
  if (outcome === 'exhausted') {
    return "We couldn't deliver the approval prompt after several attempts. Approve from the pending list or resume the job to try again.";
  }
  if (outcome === 'expired') {
    return 'The approval prompt expired. Resume the job to get a fresh one.';
  }
  return 'The approval prompt is no longer active.';
}
