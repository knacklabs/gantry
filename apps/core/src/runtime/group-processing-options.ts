import type { GroupAgentRunResult } from './group-agent-runner.js';

export type ActiveTurnUiCleanup = {
  token: symbol;
  cancel: () => void | Promise<void>;
};
