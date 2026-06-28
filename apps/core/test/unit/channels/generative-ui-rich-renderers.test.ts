import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

const fallbackCopy =
  'Rich view unavailable in this conversation. Showing text version.';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('generative UI provider renderers', () => {
  it('uses the exact native-render fallback copy across provider renderers', () => {
    for (const file of [
      'apps/core/src/channels/rich-interaction.ts',
      'apps/core/src/channels/slack/channel-delivery.ts',
      'apps/core/src/channels/discord.ts',
    ]) {
      const source = read(file);
      expect(
        source.includes(fallbackCopy) ||
          source.includes('RICH_INTERACTION_FALLBACK_COPY'),
        file,
      ).toBe(true);
    }
  });

  it('keeps Slack multi-field and free-text forms behind an Open form modal', () => {
    const slackSources = [
      read('apps/core/src/channels/rich-interaction.ts'),
      read('apps/core/src/channels/slack/channel-delivery.ts'),
      read('apps/core/src/channels/slack/channel-interactions.ts'),
      read('apps/core/src/channels/slack/permission-blocks.ts'),
    ].join('\n');

    expect(slackSources).toContain('Open form');
    expect(slackSources).toContain('Submit');
    expect(slackSources).toContain('Cancel');
    expect(slackSources).toContain(
      'Complete the required fields before submitting.',
    );
    expect(slackSources).toContain('Submitted by');
    expect(slackSources).toMatch(/views\.open|type:\s*'modal'|type:\s*"modal"/);
  });

  it('keeps Discord multi-field and free-text forms behind interaction modals', () => {
    const discord = [
      read('apps/core/src/channels/rich-interaction.ts'),
      read('apps/core/src/channels/discord.ts'),
    ].join('\n');

    expect(discord).toContain('Open form');
    expect(discord).toContain('Submit');
    expect(discord).toContain('Cancel');
    expect(discord).toContain(
      'Complete the required fields before submitting.',
    );
    expect(discord).toContain('Submitted by');
    expect(discord).toMatch(/interaction/i);
    expect(discord).toMatch(/modal|type:\s*9/);
  });
});
