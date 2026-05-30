import { describe, expect, it } from 'vitest';

import {
  deliveryLabel,
  ownerLabel,
} from '@core/channels/provider-delivery-labels.js';

describe('provider delivery labels', () => {
  describe('deliveryLabel', () => {
    it('labels Telegram group vs topic', () => {
      expect(deliveryLabel('tg:-100123', null)).toBe('Telegram group');
      expect(deliveryLabel('tg:-100123', '42')).toBe('Telegram topic');
    });

    it('does not call Telegram direct chats groups', () => {
      expect(deliveryLabel('tg:5759865942', null)).toBe('Telegram chat');
      expect(ownerLabel('tg:5759865942')).toBe('Telegram chat');
    });

    it('labels Slack channel vs thread', () => {
      expect(deliveryLabel('sl:C0001', null)).toBe('Slack channel');
      expect(deliveryLabel('sl:C0001', '1700000000.0001')).toBe('Slack thread');
    });

    it('labels Slack DMs separately from channels', () => {
      expect(deliveryLabel('sl:D0001', null)).toBe('Slack DM');
      expect(ownerLabel('sl:D0001')).toBe('Slack DM');
    });

    it('labels Teams channel vs reply thread', () => {
      expect(deliveryLabel('teams:team-1', null, 'channel')).toBe(
        'Teams channel',
      );
      expect(deliveryLabel('teams:team-1', 'reply-1')).toBe(
        'Teams reply thread',
      );
    });

    it('uses neutral Teams labels when channel/chat kind is unavailable', () => {
      expect(deliveryLabel('teams:team-1', null)).toBe('Teams conversation');
      expect(ownerLabel('teams:team-1')).toBe('Teams conversation');
      expect(deliveryLabel('teams:chat-1', null, 'dm')).toBe('Teams chat');
      expect(ownerLabel('teams:chat-1', 'dm')).toBe('Teams chat');
    });

    it('labels App conversation vs session', () => {
      expect(deliveryLabel('app:default', null)).toBe('App conversation');
      expect(deliveryLabel('app:default', 'sess-1')).toBe('App session');
    });

    it('treats blank thread ids as no thread', () => {
      expect(deliveryLabel('sl:C0001', '   ')).toBe('Slack channel');
    });

    it('falls back to a neutral label for unknown prefixes', () => {
      expect(deliveryLabel('unknown:xyz', null)).toBe('conversation');
      expect(deliveryLabel('unknown:xyz', 'x')).toBe('conversation');
    });
  });

  describe('ownerLabel', () => {
    it('uses the conversation level, never the thread', () => {
      expect(ownerLabel('tg:-100123')).toBe('Telegram group');
      expect(ownerLabel('sl:C0001')).toBe('Slack channel');
      expect(ownerLabel('teams:team-1', 'channel')).toBe('Teams channel');
      expect(ownerLabel('app:default')).toBe('App conversation');
    });

    it('falls back to a neutral label for unknown prefixes', () => {
      expect(ownerLabel('unknown:xyz')).toBe('conversation');
    });
  });
});
