import * as p from '@clack/prompts';

import { AgentDmAccessAdministrationService } from '../application/agents/agent-dm-access-administration-service.js';
import { ApplicationError } from '../application/common/application-error.js';
import type { AgentId } from '../domain/agent/agent.js';

export async function runAgentDmAccessCommand(args: string[]): Promise<number> {
  const [agentId, ...rest] = args;
  if (!agentId) {
    p.log.error(
      'Usage: myclaw agent dm-access <agentId> [--provider <provider> --allow <userId,userId> --admin <userId>]',
    );
    return 1;
  }

  const provider = readFlag(rest, '--provider');
  const allowIndex = rest.indexOf('--allow');
  const allowValue = allowIndex >= 0 ? rest[allowIndex + 1] || '' : '';
  const adminValue = readFlag(rest, '--admin');

  if ((allowIndex >= 0 || adminValue !== undefined) && !provider) {
    p.log.error('Use --provider when replacing agent DM access or admin.');
    return 1;
  }

  try {
    const service = await agentDmAccessService();
    if (allowIndex >= 0 || adminValue !== undefined) {
      const current = await service.getDmAccess({
        appId: 'default' as never,
        agentId: agentId as AgentId,
      });
      const providerId = provider!.trim().toLowerCase();
      const nextEntries = current.dmAccess.entries.filter(
        (entry) => entry.provider !== providerId,
      );
      nextEntries.push({
        provider: providerId,
        userIds:
          allowIndex >= 0
            ? parseCsv(allowValue)
            : (current.dmAccess.entries.find(
                (entry) => entry.provider === providerId,
              )?.userIds ?? []),
        adminUserId:
          adminValue !== undefined
            ? adminValue.trim() || undefined
            : current.dmAccess.entries.find(
                (entry) => entry.provider === providerId,
              )?.adminUserId,
      });
      const updated = await service.replaceDmAccess({
        appId: 'default' as never,
        agentId: agentId as AgentId,
        entries: nextEntries,
      });
      p.note(formatDmAccess(updated.dmAccess.entries), 'Agent DM Access');
      return 0;
    }

    const current = await service.getDmAccess({
      appId: 'default' as never,
      agentId: agentId as AgentId,
    });
    p.note(formatDmAccess(current.dmAccess.entries), 'Agent DM Access');
    return 0;
  } catch (error) {
    p.log.error(formatAgentAdminError(error));
    return 1;
  }
}

async function agentDmAccessService(): Promise<AgentDmAccessAdministrationService> {
  const { getRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  return new AgentDmAccessAdministrationService(
    getRuntimeStorage().repositories,
  );
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] || '';
  const prefix = `${flag}=`;
  const matched = args.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatDmAccess(
  entries: Array<{ provider: string; userIds: string[]; adminUserId?: string }>,
): string {
  if (entries.length === 0) return 'none';
  return entries
    .map((entry) =>
      [
        `${entry.provider}: ${entry.userIds.join(', ') || 'none'}`,
        entry.adminUserId ? `admin ${entry.adminUserId}` : 'admin none',
      ].join(' | '),
    )
    .join('\n');
}

function formatAgentAdminError(error: unknown): string {
  if (error instanceof ApplicationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
