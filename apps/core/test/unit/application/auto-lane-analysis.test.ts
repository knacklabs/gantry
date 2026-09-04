import { describe, expect, it } from 'vitest';

import { deriveAutoLaneAnalysis } from '@core/application/permissions/auto-lane-analysis.js';

function readOnlyMetaExecutor(command: string): boolean {
  return deriveAutoLaneAnalysis({ permissionMode: 'auto', command })
    .readOnlyMetaExecutor;
}

describe('auto lane analysis', () => {
  it('derives readOnlyMetaExecutor true for find without any of the nine write-capable actions only', () => {
    for (const command of [
      'find . -delete',
      'find . -exec echo {} +',
      'find . -execdir echo {} +',
      'find . -ok echo {} +',
      'find . -okdir echo {} +',
      'find . -fls results.txt',
      'find . -fprint results.txt',
      'find . -fprint0 results.txt',
      'find . -fprintf results.txt %p',
    ]) {
      expect(readOnlyMetaExecutor(command), command).toBe(false);
    }
    expect(readOnlyMetaExecutor('find .')).toBe(true);
    expect(readOnlyMetaExecutor("find ./src -name '*.ts'")).toBe(true);
  });

  it('keeps the veto in interactive auto for find with a sensitive shape in the first operand, a later operand or a predicate value, for .., hidden and secret names, for -H -L or -follow, for -files0-from or any indirect root option, any redirect, a compound or a pipeline, and allows find . and find ./src -name *.ts', () => {
    for (const command of [
      'find /etc/shadow',
      'find ./src /etc/shadow',
      'find . -name .env',
      "find . -path '*/.ssh/*'",
      'find . -newer /etc/shadow',
      'find ..',
      'find .git',
      'find id_rsa',
      'find -H .',
      'find -L .',
      'find . -follow',
      'find -files0-from roots.txt',
      'find --files0-from=roots.txt',
      'find -f roots.txt',
      'find -Z roots.txt',
      'find . > results.txt',
      'find . 2>/dev/null',
      'find . && echo done',
      'find . | wc -l',
      '(find .)',
    ]) {
      expect(readOnlyMetaExecutor(command), command).toBe(false);
    }
    expect(readOnlyMetaExecutor('find .')).toBe(true);
    expect(readOnlyMetaExecutor("find ./src -name '*.ts'")).toBe(true);
  });
});
