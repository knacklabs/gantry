import { AGENT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';
import { MessageSink, NewMessage, RegisteredGroup } from '../core/types.js';
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
  findMessageSink: (chatJid: string) => MessageSink | undefined,
  isSenderControlAllowlisted: (msg: NewMessage) => boolean,
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

  if (!(msg.is_from_me === true || isSenderControlAllowlisted(msg))) {
    logger.warn(
      { chatJid, sender: msg.sender },
      'Remote control rejected: sender not authorized',
    );
    return;
  }

  const sink = findMessageSink(chatJid);
  if (!sink) return;

  if (command === '/remote-control') {
    const result = await startRemoteControl(msg.sender, chatJid, cwd);
    if (result.ok) {
      await sink.sendMessage(chatJid, result.url);
      return;
    }
    await sink.sendMessage(chatJid, `Remote Control failed: ${result.error}`);
    return;
  }

  const result = stopRemoteControl();
  if (result.ok) {
    await sink.sendMessage(chatJid, 'Remote Control session ended.');
    return;
  }
  await sink.sendMessage(chatJid, result.error);
}
