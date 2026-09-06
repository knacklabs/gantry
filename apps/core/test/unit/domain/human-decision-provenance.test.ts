import { describe, expect, it } from 'vitest';

import {
  decodeHumanDecisionProvenance,
  encodeHumanDecisionProvenance,
  HumanDecisionOutcome,
  HumanDecisionScope,
  isRememberResolution,
  resolutionMode,
  type PermissionApprovalDecisionMode,
  type PermissionApprovalResolution,
} from '@core/domain/types.js';

describe('human decision provenance', () => {
  it('encodes human_decision provenance with a fixed prefix and canonical body carrying id, person, outcome, scope and rail version and decodes it back, failing closed on another prefix, a malformed body, a missing field, a non-integer rail version or a non-uuid id, and the remember resolution guards distinguish a structured remember from every scalar mode', () => {
    const value = {
      id: '12345678-1234-4abc-8def-1234567890ab',
      actingPersonId: 'person-1',
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
      railVersion: 7,
    };
    const encoded = encodeHumanDecisionProvenance(value);

    expect(encoded).toBe(
      'human_decision:{"actingPersonId":"person-1","id":"12345678-1234-4abc-8def-1234567890ab","outcome":"allow","railVersion":7,"scope":"exact"}',
    );
    expect(decodeHumanDecisionProvenance(encoded)).toEqual(value);

    for (const malformed of [
      encoded.replace('human_decision:', 'classifier:'),
      'human_decision:{',
      `human_decision:${JSON.stringify({ ...value, actingPersonId: undefined })}`,
      `human_decision:${JSON.stringify({ ...value, railVersion: 1.5 })}`,
      `human_decision:${JSON.stringify({ ...value, id: 'not-a-uuid' })}`,
    ]) {
      expect(decodeHumanDecisionProvenance(malformed)).toBeUndefined();
    }

    const remember: PermissionApprovalResolution = {
      kind: 'remember',
      outcome: HumanDecisionOutcome.Deny,
      scope: HumanDecisionScope.Exact,
    };
    expect(isRememberResolution(remember)).toBe(true);
    expect(resolutionMode(remember)).toBeUndefined();

    for (const mode of [
      'allow_once',
      'allow_persistent_rule',
      'cancel',
    ] satisfies PermissionApprovalDecisionMode[]) {
      const resolution: PermissionApprovalResolution = { kind: 'mode', mode };
      expect(isRememberResolution(resolution)).toBe(false);
      expect(resolutionMode(resolution)).toBe(mode);
    }
  });
});
