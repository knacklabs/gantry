import { describe, expect, it } from 'vitest';

import {
  hasSelectedItOpsSkill,
  ITOPS_NATIVE_TOOL_NAMES,
} from '@core/runner/itops-native-tool-surface.js';

describe('IT Ops native tool surface', () => {
  it('keeps the frozen bridge inventory of 39 unique tool names', () => {
    expect(ITOPS_NATIVE_TOOL_NAMES).toHaveLength(39);
    expect(new Set(ITOPS_NATIVE_TOOL_NAMES).size).toBe(39);
  });

  it.each([
    [['itops (skill:uuid)'], true],
    [['itops'], true],
    [['ITOps (skill:uuid)'], false],
    [['my-itops (skill:uuid)'], false],
    [['ats-skills (skill:uuid)'], false],
    [[], false],
  ] as const)(
    'matches only the canonical selected itops skill for %j',
    (displays, expected) => {
      expect(hasSelectedItOpsSkill(displays)).toBe(expected);
    },
  );
});
