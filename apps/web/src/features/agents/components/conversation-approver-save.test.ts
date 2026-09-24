import { describe, expect, it, vi } from 'vitest';

import {
  normalizeApproverIds,
  saveConversationApprovers,
  sameApprovers,
} from './conversation-approver-save';

describe('conversation approver update', () => {
  it('normalizes IDs without dropping existing approvers', () => {
    expect(normalizeApproverIds([' U2 ', 'U1', 'U2'])).toEqual(['U1', 'U2']);
    expect(sameApprovers(['U2', 'U1'], ['U1', 'U2'])).toBe(true);
  });

  it('verifies the complete list before replacing it', async () => {
    const order: string[] = [];
    const replace = vi.fn(async (ids: string[]) => {
      order.push('replace');
      return ids;
    });
    await saveConversationApprovers({
      selected: ['U2', 'U1', 'U2'],
      initial: ['U1'],
      current: async () => {
        order.push('current');
        return ['U1'];
      },
      verify: async (ids) => {
        order.push('verify');
        expect(ids).toEqual(['U1', 'U2']);
        return { invalidUserIds: [] };
      },
      replace,
    });
    expect(order).toEqual(['current', 'verify', 'replace']);
    expect(replace).toHaveBeenCalledWith(['U1', 'U2']);
  });

  it('does not save a non-member or overwrite a changed list', async () => {
    const replace = vi.fn(async () => undefined);
    await expect(
      saveConversationApprovers({
        selected: ['U1', 'UNKNOWN'],
        initial: ['U1'],
        current: async () => ['U1'],
        verify: async () => ({ invalidUserIds: ['UNKNOWN'] }),
        replace,
      }),
    ).rejects.toThrow('Not eligible');
    await expect(
      saveConversationApprovers({
        selected: ['U1', 'U2'],
        initial: ['U1'],
        current: async () => ['U1', 'U3'],
        verify: async () => ({ invalidUserIds: [] }),
        replace,
      }),
    ).rejects.toThrow('changed elsewhere');
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not remove every approver', async () => {
    const replace = vi.fn(async () => undefined);
    await expect(
      saveConversationApprovers({
        selected: [],
        initial: ['U1'],
        current: async () => ['U1'],
        verify: async () => ({ invalidUserIds: [] }),
        replace,
      }),
    ).rejects.toThrow('Choose at least one');
    expect(replace).not.toHaveBeenCalled();
  });
});
