import { nowIso } from '../shared/time/datetime.js';
import { findConversationRoutesForChat } from '../shared/thread-queue-key.js';
import { ApplicationError } from '../application/common/application-error.js';
import type { ChannelOpts } from './channel-provider.js';

export const GROUP_INSTALL_MANUAL_SETUP_MESSAGE =
  "I don't know who added me. An existing approver can register this group from settings.";

// Discord's join surface (GUILD_CREATE) carries no inviter and REFIRES on
// every gateway reconnect, so it gets this lighter path: one manual-setup
// notice per guild, ever — no conversation metadata, no registration. The
// claim row is marked terminal after the notice so reconnects past the claim
// window can never re-post (unlike a real re-add on Telegram/Slack, which is
// a deliberate human act and may retry).
export async function noticeManualGroupInstall(input: {
  opts: ChannelOpts;
  providerAccountId: string;
  dedupJid: string;
  send: (text: string) => Promise<unknown>;
}): Promise<'manual' | 'deduplicated'> {
  const coordinator = input.opts.groupJoinOnboarding;
  if (!coordinator) return 'deduplicated';
  const record = await coordinator.beginBootstrap({
    providerAccountId: input.providerAccountId,
    chatJid: input.dedupJid,
    installerExternalId: undefined,
  });
  if (!record) return 'deduplicated';
  await sendBestEffort(input.send, GROUP_INSTALL_MANUAL_SETUP_MESSAGE);
  // 'registered' here means "this notice is settled", making the row-level
  // dedup permanent; actual conversation registration for Discord is manual.
  await coordinator.seedNoticeSettled?.({ id: record.id });
  return 'manual';
}

export async function bootstrapGroupInstall(input: {
  opts: ChannelOpts;
  provider: string;
  providerAccountId: string;
  chatJid: string;
  title: string;
  installerExternalId?: string;
  send: (text: string) => Promise<unknown>;
}): Promise<'registered' | 'manual' | 'deduplicated'> {
  await input.opts.onChatMetadata(
    input.chatJid,
    nowIso(),
    input.title,
    input.provider,
    true,
    { providerAccountId: input.providerAccountId },
  );

  if (
    findConversationRoutesForChat(
      input.opts.conversationRoutes(),
      input.chatJid,
      undefined,
      input.providerAccountId,
    ).length > 0
  ) {
    return 'deduplicated';
  }

  const coordinator = input.opts.groupJoinOnboarding;
  if (!coordinator) return 'deduplicated';
  const record = await coordinator.beginBootstrap({
    providerAccountId: input.providerAccountId,
    chatJid: input.chatJid,
    installerExternalId: input.installerExternalId,
  });
  if (!record) return 'deduplicated';

  const installerExternalId = input.installerExternalId?.trim();
  const recognised = installerExternalId
    ? await isRecognisedInstaller({
        opts: input.opts,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        installerExternalId,
      })
    : false;
  if (!recognised || !installerExternalId) {
    await sendBestEffort(input.send, GROUP_INSTALL_MANUAL_SETUP_MESSAGE);
    return 'manual';
  }

  const registered = await coordinator.seedInstaller({
    id: record.id,
    provider: input.provider,
    externalId: input.chatJid.replace(/^[^:]+:/, ''),
    title: input.title,
    installerExternalId,
  });
  if (!registered) return 'deduplicated';
  await sendBestEffort(
    input.send,
    // No raw provider ids in chat copy; the installer knows who they are.
    "I'm set up. The person who added me can approve what I'm allowed to do here.",
  );
  return 'registered';
}

async function isRecognisedInstaller(input: {
  opts: ChannelOpts;
  provider: string;
  providerAccountId: string;
  installerExternalId: string;
}): Promise<boolean> {
  if (
    !input.opts.resolvePersonIdentity ||
    !input.opts.hasDirectConversationWithPerson
  ) {
    return false;
  }
  try {
    const identity = await input.opts.resolvePersonIdentity({
      appId: input.opts.appId ?? 'default',
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      externalUserId: input.installerExternalId,
      evidenceType: 'provider_user',
      createIfMissing: false,
    });
    return Boolean(
      identity.personId &&
      (await input.opts.hasDirectConversationWithPerson(
        input.opts.appId ?? 'default',
        identity.personId,
      )),
    );
  } catch (err) {
    if (err instanceof ApplicationError && err.code === 'CONFLICT') {
      return false;
    }
    throw err;
  }
}

async function sendBestEffort(
  send: (text: string) => Promise<unknown>,
  text: string,
): Promise<void> {
  try {
    await send(text);
  } catch {
    // Registration/dedup state is authoritative; delivery is best effort.
  }
}
