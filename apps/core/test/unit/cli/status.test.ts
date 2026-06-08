import { describe, expect, it } from 'vitest';

import { formatRuntimeStatus } from '@core/cli/status.js';
import type { RuntimeStatusSummary } from '@core/cli/status.js';

describe('status command formatting', () => {
  it('reports provider DMs separately from group/channel conversations', () => {
    const output = formatRuntimeStatus({
      runtimeHome: '/tmp/gantry',
      runtimeMode: 'host',
      doctor: {
        ok: true,
        warnings: 0,
        blockingFailures: 0,
        checks: [],
      },
      service: { kind: 'launchd', status: 'running(pid:123)' },
      channels: [
        {
          id: 'telegram',
          label: 'Telegram',
          enabled: true,
          configuredEnvKeys: ['TELEGRAM_BOT_TOKEN'],
          missingEnvKeys: [],
          conversations: 2,
          dms: 1,
          channels: 1,
        },
      ],
      memoryEnabled: true,
      memoryHealth: 'pass',
      storageCapabilityHealth: 'pass',
      storageCapabilityMessage: 'Postgres capabilities are ready.',
      embeddingsEnabled: false,
      embeddingProvider: 'disabled',
      embeddingProviderSource: 'settings.yaml',
      embeddingProviderHealth: 'pass',
      embeddingModel: 'text-embedding-3-small',
      embeddingModelSource: 'settings.yaml',
      dreamingEnabled: true,
      dreamingSource: 'settings.yaml',
      queuePolicy: {
        maxMessageRuns: 3,
        maxJobRuns: 4,
        maxRetries: 5,
        baseRetryMs: 5000,
      },
    } satisfies RuntimeStatusSummary);

    expect(output).toContain(
      'Telegram: enabled | credentials: configured | conversations: 2 (DMs: 1, channels/groups: 1)',
    );
    expect(output).not.toContain('groups: 2');
  });
});
