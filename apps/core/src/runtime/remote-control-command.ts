import { AGENT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../core/types.js';
import { startRemoteControl, stopRemoteControl } from './remote-control.js';

export type RemoteControlCommand = '/remote-control' | '/remote-control-end';

export function asRemoteControlCommand(
  text: string,
): RemoteControlCommand | null {
  if (text === '/remote-control' || text === '/remote-control-end') {
    return text;
  }
  return null;
}

export async function handleRemoteControlCommand(
  command: RemoteControlCommand,
  chatJid: string,
  msg: NewMessage,
  getGroup: (chatJid: string) => RegisteredGroup | undefined,
  findChannel: (chatJid: string) => Channel | undefined,
  cwd = AGENT_ROOT,
): Promise<void> {
  const group = getGroup(chatJid);
  if (!group?.isMain) {
    logger.warn(
      { chatJid, sender: msg.sender },
      'Remote control rejected: not main group',
    );
    return;
  }

  const channel = findChannel(chatJid);
  if (!channel) return;

  if (command === '/remote-control') {
    const result = await startRemoteControl(msg.sender, chatJid, cwd);
    if (result.ok) {
      await channel.sendMessage(chatJid, result.url);
      return;
    }
    await channel.sendMessage(
      chatJid,
      `Remote Control failed: ${result.error}`,
    );
    return;
  }

  const result = stopRemoteControl();
  if (result.ok) {
    await channel.sendMessage(chatJid, 'Remote Control session ended.');
    return;
  }
  await channel.sendMessage(chatJid, result.error);
}
