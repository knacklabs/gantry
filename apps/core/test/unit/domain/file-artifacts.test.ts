import { describe, expect, it } from 'vitest';

import { isProtectedFileArtifactVirtualPath } from '@core/domain/file-artifacts/protected-virtual-path.js';
import { normalizeFileArtifactPath } from '@core/domain/file-artifacts/virtual-path.js';

describe('file artifact virtual paths', () => {
  it('allows protected hidden virtual paths while rejecting traversal', () => {
    expect(normalizeFileArtifactPath('.mcp.json')).toBe('.mcp.json');
    expect(normalizeFileArtifactPath('.codex/skills/review/SKILL.md')).toBe(
      '.codex/skills/review/SKILL.md',
    );
    expect(() => normalizeFileArtifactPath('../settings.yaml')).toThrow(
      /safe relative virtual path/,
    );
  });

  it('recognizes protected prompt and capability paths', () => {
    expect(isProtectedFileArtifactVirtualPath('agents/main/SOUL.md')).toBe(
      true,
    );
    expect(isProtectedFileArtifactVirtualPath('.mcp.json')).toBe(true);
    expect(
      isProtectedFileArtifactVirtualPath('.codex/skills/review/SKILL.md'),
    ).toBe(true);
    expect(isProtectedFileArtifactVirtualPath('notes/SOUL-notes.md')).toBe(
      false,
    );
  });
});
