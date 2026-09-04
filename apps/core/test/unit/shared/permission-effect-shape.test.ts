import { describe, expect, it } from 'vitest';

import { parseBashCommand } from '@core/shared/bash-command-parser.js';
import {
  classifyPermissionEffectShape,
  PermissionEffectShape,
} from '@core/shared/permission-effect-shape.js';

function leaf(command: string) {
  const parsed = parseBashCommand(command);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.leaves[0]!;
}

describe('permission effect shape', () => {
  it('classifies read-only command and file-read shapes with action, targets and requiresTarget without touching the filesystem', () => {
    expect(
      classifyPermissionEffectShape(leaf('uname -s'), { stdinOk: false }),
    ).toEqual({
      kind: PermissionEffectShape.ReadOnlyCommand,
      executable: 'uname',
      targets: [],
    });
    expect(
      classifyPermissionEffectShape(leaf('cat README.md'), { stdinOk: false }),
    ).toEqual({
      kind: PermissionEffectShape.FileRead,
      action: 'read',
      targets: ['README.md'],
      requiresTarget: true,
    });
    expect(
      classifyPermissionEffectShape(leaf('cat'), { stdinOk: true }),
    ).toEqual({
      kind: PermissionEffectShape.FileRead,
      action: 'read',
      targets: [],
      requiresTarget: false,
    });
    expect(
      classifyPermissionEffectShape(leaf('grep -n Gantry README.md'), {
        stdinOk: false,
      }),
    ).toEqual({
      kind: PermissionEffectShape.FileRead,
      action: 'read',
      targets: ['README.md'],
      requiresTarget: true,
    });
  });
});
