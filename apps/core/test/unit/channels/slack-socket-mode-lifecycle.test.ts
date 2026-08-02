import { describe, expect, it } from 'vitest';
import { SocketModeClient } from '@slack/socket-mode';

import { SLACK_SOCKET_MODE_RECONNECT_EVENT } from '@core/channels/slack/channel-connect.js';

describe('Slack Socket Mode lifecycle contract', () => {
  it('uses a transport event registered by the installed SDK client', () => {
    const client = new SocketModeClient({ appToken: 'xapp-test' });

    expect(client.eventNames()).toContain(SLACK_SOCKET_MODE_RECONNECT_EVENT);
  });
});
