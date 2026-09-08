import * as p from '@clack/prompts';

import { parseGroupPolicyShowArgs } from './group-args.js';
import { printPolicyChannel } from './group-policy-format.js';
import { getProviderIds } from './provider-utils.js';

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Read-only sender-policy display command. */
export async function runPolicyShow(input: {
  runtimeHome: string;
  args: string[];
  loadSettings: (
    runtimeHome: string,
  ) => Parameters<typeof printPolicyChannel>[1];
}): Promise<number> {
  const parsed = parseGroupPolicyShowArgs(input.args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  try {
    const settings = input.loadSettings(input.runtimeHome);
    if (parsed.channel) {
      printPolicyChannel(parsed.channel, settings);
      return 0;
    }
    const channels = getProviderIds();
    for (let i = 0; i < channels.length; i += 1) {
      printPolicyChannel(channels[i]!, settings);
      if (i < channels.length - 1) console.log('');
    }
    return 0;
  } catch (err) {
    p.log.error(`Could not read sender policies: ${errorMessage(err)}`);
    return 1;
  }
}
