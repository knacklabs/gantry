import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import {
  getProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';

export async function runProviderConnectCommand(
  runtimeHome: string,
  providerId: string,
  agentId?: string,
  agentName?: string,
): Promise<number> {
  const provider = getProvider(providerId);
  const isConnectable = listConnectableChannelProviders().some(
    (entry) => entry.id === providerId,
  );
  if (!provider || !isConnectable) {
    p.log.error(`Unknown provider: ${providerId}`);
    return 1;
  }

  const prompt = async (question: string): Promise<string> => {
    const answer = await p.text({ message: question });
    if (p.isCancel(answer)) {
      throw new Error('cancelled');
    }
    return String(answer).trim();
  };

  const confirm = async (question: string): Promise<boolean> => {
    const answer = await p.confirm({ message: question });
    if (p.isCancel(answer)) {
      throw new Error('cancelled');
    }
    return Boolean(answer);
  };

  try {
    await provider.setup.run({
      runtimeHome,
      agentId,
      agentName,
      prompt,
      confirm,
    });
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'cancelled') {
      p.outro('Channel connect cancelled.');
      return 1;
    }
    p.log.error(`${provider.label} connect failed: ${message}`);
    return 1;
  }
}
