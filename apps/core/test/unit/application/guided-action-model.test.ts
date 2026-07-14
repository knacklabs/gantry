import { describe, expect, it } from 'vitest';

import type { ControlPlaneNextAction } from '@core/application/control-plane/control-plane-read-model.js';
import {
  GUIDED_ACTION_DESCRIPTORS,
  describeGuidedAction,
  guidedActionTypeForControlPlaneKind,
  resolveControlPlaneGuidedAction,
  type GuidedActionType,
} from '@core/application/guided-actions/guided-action-model.js';

const ALL_KINDS: ControlPlaneNextAction['kind'][] = [
  'runtime_blocked',
  'missing_model_credential',
  'missing_provider_connection',
  'missing_conversation_install',
  'missing_access_approval',
  'blocked_job',
  'memory_review_setup',
  'none',
];

describe('guided action model', () => {
  it('maps every control-plane next-action kind to a guided action type', () => {
    for (const kind of ALL_KINDS) {
      const type = guidedActionTypeForControlPlaneKind(kind);
      expect(GUIDED_ACTION_DESCRIPTORS[type]).toBeDefined();
    }
  });

  it('resolves the documented kind -> action mapping', () => {
    const expected: Record<ControlPlaneNextAction['kind'], GuidedActionType> = {
      runtime_blocked: 'run_verification',
      missing_model_credential: 'connect_provider',
      missing_provider_connection: 'connect_provider',
      missing_conversation_install: 'add_conversation_install',
      missing_access_approval: 'grant_access',
      blocked_job: 'resume_job',
      memory_review_setup: 'review_memory',
      none: 'none',
    };
    for (const kind of ALL_KINDS) {
      expect(guidedActionTypeForControlPlaneKind(kind)).toBe(expected[kind]);
    }
  });

  it('preserves the source label when resolving a guided action ref', () => {
    const ref = resolveControlPlaneGuidedAction({
      kind: 'blocked_job',
      label: 'Review blocked jobs.',
    });
    expect(ref).toEqual({ type: 'resume_job', label: 'Review blocked jobs.' });
  });

  it('keeps descriptor authority consistent with the locked decisions', () => {
    // Grants are durable in the access policy and the current path also mirrors
    // to settings.yaml, so the preview must declare the settings write.
    expect(describeGuidedAction('grant_access').writesSettings).toBe(true);
    expect(describeGuidedAction('grant_access').requiresApproval).toBe(true);
    // Restart is explicit and never hidden.
    expect(describeGuidedAction('restart_runtime').restartsRuntime).toBe(true);
    expect(describeGuidedAction('restart_runtime').requiresApproval).toBe(true);
    // Verification is read-only.
    expect(describeGuidedAction('run_verification').writesSettings).toBe(false);
    expect(describeGuidedAction('run_verification').restartsRuntime).toBe(
      false,
    );
    // none never changes anything.
    const none = describeGuidedAction('none');
    expect(none.writesSettings).toBe(false);
    expect(none.restartsRuntime).toBe(false);
    expect(none.requiresApproval).toBe(false);
  });

  it('exposes a descriptor whose type matches its key', () => {
    for (const [key, descriptor] of Object.entries(GUIDED_ACTION_DESCRIPTORS)) {
      expect(descriptor.type).toBe(key);
      expect(descriptor.effect.length).toBeGreaterThan(0);
    }
  });
});
