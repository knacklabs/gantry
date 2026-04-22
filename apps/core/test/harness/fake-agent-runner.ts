export interface FakeAgentInvocation {
  groupFolder: string;
  chatJid: string;
  prompt: string;
  isMain: boolean;
  isScheduledJob: boolean;
  sessionId?: string;
  memoryContextBlock?: string;
  model?: string;
  script?: string;
  input: any;
}

interface FakeAgentRunResult {
  resultText?: string;
  newSessionId?: string;
  failWithError?: string;
  outputBeforeFailureText?: string;
}

export interface FakeAgentRunnerOptions {
  resultText?: string;
  newSessionId?: string;
  failWithError?: string;
  blockUntilReleased?: boolean;
  outputBeforeFailureText?: string;
  registerProcess?: boolean;
  sequence?: FakeAgentRunResult[];
}

export function createFakeAgentRunner(options: FakeAgentRunnerOptions = {}) {
  const invocations: FakeAgentInvocation[] = [];
  const releaseWaiters: Array<() => void> = [];

  const runAgent = async (
    group: any,
    input: any,
    onProcess: any,
    onOutput?: (output: any) => Promise<void>,
  ) => {
    const runOptions = options.sequence?.[invocations.length] ?? options;
    invocations.push({
      groupFolder: group.folder,
      chatJid: input.chatJid,
      prompt: input.prompt,
      isMain: input.isMain === true,
      isScheduledJob: input.isScheduledJob === true,
      sessionId: input.sessionId,
      memoryContextBlock: input.memoryContextBlock,
      model: input.model,
      script: input.script,
      input,
    });

    if (options.registerProcess !== false) {
      onProcess?.(
        {
          killed: false,
          kill: () => {
            // The fake process only needs the ChildProcess surface used by GroupQueue.
          },
        },
        `fake-agent-${group.folder}-${invocations.length}`,
      );
    }

    if (options.blockUntilReleased) {
      await new Promise<void>((resolve) => {
        releaseWaiters.push(resolve);
      });
    }

    if (runOptions.outputBeforeFailureText) {
      await onOutput?.({
        status: 'error',
        result: runOptions.outputBeforeFailureText,
        error: runOptions.failWithError ?? 'fake-agent-error-after-output',
      });
      return {
        status: 'error',
        result: runOptions.outputBeforeFailureText,
        error: runOptions.failWithError ?? 'fake-agent-error-after-output',
      } as const;
    }

    if (runOptions.failWithError) {
      const errorOutput = {
        status: 'error',
        result: null,
        error: runOptions.failWithError,
      } as const;
      if (onOutput) await onOutput(errorOutput);
      return errorOutput;
    }

    const output = {
      status: 'success',
      result: runOptions.resultText ?? 'fake-agent-result',
      newSessionId: runOptions.newSessionId,
      error: null,
    } as const;
    if (onOutput) await onOutput(output);
    return output;
  };

  const releaseNext = (): void => {
    const resolve = releaseWaiters.shift();
    resolve?.();
  };

  const releaseAll = (): void => {
    for (const resolve of releaseWaiters.splice(0)) resolve();
  };

  return { invocations, runAgent, releaseNext, releaseAll };
}
