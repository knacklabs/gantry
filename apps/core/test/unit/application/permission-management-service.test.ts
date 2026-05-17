import { describe, expect, it, vi } from 'vitest';

import { PermissionManagementService } from '@core/application/permissions/permission-management-service.js';
import type { PermissionRepository } from '@core/domain/ports/repositories.js';
import type { PermissionDecision } from '@core/domain/permissions/permissions.js';

function permissionRepository(): {
  repository: PermissionRepository;
  saveDecision: ReturnType<typeof vi.fn>;
} {
  const saveDecision = vi.fn();
  return {
    saveDecision,
    repository: {
      savePolicy: vi.fn(),
      saveRule: vi.fn(),
      saveDecision,
      getDecision: vi.fn(),
    },
  };
}

describe('PermissionManagementService', () => {
  it('records timed grant expiry for audit without requiring a new schema', async () => {
    const { repository, saveDecision } = permissionRepository();
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });

    await service.recordDecision({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      requestId: 'permission_123',
      toolName: 'Bash',
      conversationId: 'tg:123',
      decision: {
        approved: true,
        mode: 'allow_timed_grant',
        reason: 'timed grant for eligible tools and SDK API prompts',
        decisionClassification: 'user_temporary',
        timedGrantExpiresAtMs: Date.parse('2026-05-15T12:05:00.000Z'),
      },
      permissionRepository: repository,
    });

    const decision = saveDecision.mock.calls[0]?.[0] as PermissionDecision;
    expect(decision.expiresAt).toBe('2026-05-15T12:05:00.000Z');
    expect(decision.actorContext).toMatchObject({
      requestId: 'permission_123',
      agentId: 'agent:test',
      conversationId: 'tg:123',
      mode: 'allow_timed_grant',
      classification: 'user_temporary',
    });
  });
});
