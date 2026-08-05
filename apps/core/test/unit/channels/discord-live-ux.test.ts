import { describe, expect, it } from 'vitest';

import { createDiscordLiveUxCapability } from '@core/channels/discord-live-ux.js';

describe('discord live-ux canonical targets', () => {
  const capability = createDiscordLiveUxCapability(() => undefined);

  it('keeps thread-less channels in distinct lanes', () => {
    const a = capability.canonicalTarget({
      operation: 'typing',
      jid: 'dc:111',
    });
    const b = capability.canonicalTarget({
      operation: 'typing',
      jid: 'dc:222',
    });
    expect(a.key).not.toBe(b.key);
  });

  it('treats an empty thread id as absent', () => {
    const bare = capability.canonicalTarget({
      operation: 'typing',
      jid: 'dc:111',
    });
    const empty = capability.canonicalTarget({
      operation: 'typing',
      jid: 'dc:111',
      threadId: '',
    });
    expect(empty).toEqual(bare);
    const other = capability.canonicalTarget({
      operation: 'typing',
      jid: 'dc:222',
      threadId: '',
    });
    expect(empty.key).not.toBe(other.key);
  });
});
