import { describe, expect, it, vi } from 'vitest';

import {
  PERMISSION_PROMOTION_ALLOW_THRESHOLD,
  processPermissionPromotion,
  schedulePermissionPromotion,
} from '@core/application/permissions/permission-promotion.js';
import type {
  PermissionPromotionCounter,
  PermissionPromotionRepository,
} from '@core/domain/ports/permission-promotion.js';

function repository(): PermissionPromotionRepository {
  let count = 0;
  let lastOfferedAt: string | null = null;
  const row = (): PermissionPromotionCounter => ({
    appId: 'app-one',
    agentFolder: 'main_agent',
    suggestionKey: 'main_agent|RunCommand(git status)',
    allowCount: count,
    lastOfferedAt,
    deniedAt: null,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  });
  return {
    incrementAndGet: async () => {
      count += 1;
      return row();
    },
    get: async () => row(),
    markOffered: async ({ nowIso }) => {
      if (lastOfferedAt) return false;
      lastOfferedAt = nowIso;
      return true;
    },
    markDenied: async () => undefined,
  };
}

const promotionInput = (
  promotionRepository: PermissionPromotionRepository,
  offer: ReturnType<typeof vi.fn>,
) => ({
  repository: promotionRepository,
  appId: 'app-one',
  agentId: 'agent-one',
  agentFolder: 'main_agent',
  suggestionKey: 'main_agent|RunCommand(git status)',
  suggestions: [
    {
      type: 'addRules' as const,
      behavior: 'allow' as const,
      destination: 'session' as const,
      rules: [{ toolName: 'RunCommand', ruleContent: 'git status' }],
    },
  ],
  toolName: 'RunCommand',
  targetJid: 'conversation-one',
  offer,
  now: () => '2026-07-12T00:00:00.000Z',
  requestId: () => 'permission-promotion-test',
});

describe('permission promotion', () => {
  it('offers exactly once when the auto-allow count reaches the threshold', async () => {
    const promotionRepository = repository();
    const offer = vi.fn(async () => undefined);
    for (
      let index = 0;
      index < PERMISSION_PROMOTION_ALLOW_THRESHOLD + 1;
      index += 1
    ) {
      await processPermissionPromotion(
        promotionInput(promotionRepository, offer),
      );
    }
    expect(offer).toHaveBeenCalledTimes(1);
    expect(offer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestFamily: 'promotion',
        decisionOptions: ['allow_persistent_rule', 'cancel'],
        suggestions: promotionInput(promotionRepository, offer).suggestions,
        description:
          "I've auto-allowed RunCommand 3 times in this conversation — make it permanent?",
      }),
    );
  });

  it('keeps the original tool path fail-open when counter persistence fails', async () => {
    const warn = vi.fn();
    const offer = vi.fn(async () => undefined);
    const toolCall = () => {
      schedulePermissionPromotion(
        promotionInput(
          {
            incrementAndGet: async () => {
              throw new Error('database unavailable');
            },
            get: async () => null,
            markOffered: async () => false,
            markDenied: async () => undefined,
          },
          offer,
        ),
        warn,
      );
      return { allowed: true };
    };
    expect(toolCall()).toEqual({ allowed: true });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(offer).not.toHaveBeenCalled();
  });
});
