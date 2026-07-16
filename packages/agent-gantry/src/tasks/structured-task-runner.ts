import { randomUUID } from 'node:crypto';
import type {
  GantryAgentTaskResult,
  GantryStructuredTaskInput,
  GantryStructuredTaskResult,
  GantryStructuredTaskRunner,
  StructuredModelTaskRunnerConfig,
  StructuredToolProviderSet,
} from '../shared/types.js';
import {
  asRecord,
  parseJsonRecord,
  readNumber,
  readString,
} from '../shared/helpers.js';
import { runGenericAgentTask } from './agent-task-runner.js';
import {
  readStructuredModelStopError,
  resolveStructuredModelProvider,
  unwrapStructuredJsonModelProviderResult,
} from './model-provider.js';
import { observeGantryAgentSpan } from './model-observability.js';

export function createStructuredModelTaskRunner(
  config: StructuredModelTaskRunnerConfig,
): GantryStructuredTaskRunner {
  const model = resolveStructuredModelProvider(config.model);
  const runnerConfig = { ...config, model };
  return {
    runStructuredTask: async (input) => {
      return await observeGantryAgentSpan<GantryStructuredTaskResult>(
        {
          operationName: 'runStructuredTask',
          taskType: input.taskType,
          correlationId: input.correlationId ?? null,
          input: {
            taskType: input.taskType,
            input: input.input,
            outputSchema: input.outputSchema ?? null,
          },
          output: (result: GantryStructuredTaskResult) => ({
            status: result.status,
            warning_count: result.warnings?.length ?? 0,
          }),
          observability: input.observability,
        },
        async () => {
          const taskRunId = input.correlationId ?? randomUUID();
          let browserContext: Record<string, unknown> | undefined;
          let toolContext: Record<string, unknown> | null = null;
          try {
            const tools = config.tools ?? { browser: config.browser };
            browserContext = await (tools.browser ?? config.browser)?.runTask?.(
              input,
            );
            toolContext = await collectStructuredToolContext(tools, input);
            const generated = unwrapStructuredJsonModelProviderResult(
              await model.generateJson({
                ...input,
                input: {
                  ...input.input,
                  ...(browserContext ? { browserContext } : {}),
                  ...(toolContext ? { toolContext } : {}),
                },
                observability: input.observability,
              }),
            );
            const stopError = readStructuredModelStopError(
              generated.stopReason,
            );
            if (stopError) throw new Error(stopError);
            const modelOutput =
              typeof generated.output === 'string'
                ? parseJsonRecord(generated.output)
                : generated.output;
            const output: Record<string, unknown> = {
              ...modelOutput,
              ...(browserContext ? { browserContext } : {}),
              ...(toolContext ? { toolContext } : {}),
            };
            const status =
              output.status === 'needs_review' || output.status === 'failed'
                ? output.status
                : 'completed';
            const result: GantryStructuredTaskResult = {
              status,
              output,
              validationReport: asRecord(output.validationReportJson) ?? {
                status,
              },
              warnings: Array.isArray(output.warnings)
                ? output.warnings.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : [],
              modelUsage: generated.modelUsage,
            };
            await config.storage?.recordStructuredTaskRun?.({
              taskRunId,
              taskType: input.taskType,
              correlationId: input.correlationId,
              status: result.status,
              input: input.input,
              output: result.output,
              validationReport: result.validationReport,
              occurredAt: new Date().toISOString(),
            });
            return result;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await config.storage?.recordStructuredTaskRun?.({
              taskRunId,
              taskType: input.taskType,
              correlationId: input.correlationId,
              status: 'failed',
              input: input.input,
              output: {
                error: message,
                ...(browserContext ? { browserContext } : {}),
                ...(toolContext ? { toolContext } : {}),
              },
              validationReport: {
                status: 'failed',
                error: message,
                ...(browserContext ? { browserContext } : {}),
                ...(toolContext ? { toolContext } : {}),
              },
              error: message,
              occurredAt: new Date().toISOString(),
            });
            return {
              status: 'failed',
              output: {
                error: message,
                ...(browserContext ? { browserContext } : {}),
                ...(toolContext ? { toolContext } : {}),
              },
              validationReport: {
                status: 'failed',
                error: message,
                ...(browserContext ? { browserContext } : {}),
                ...(toolContext ? { toolContext } : {}),
              },
              warnings: [message],
            };
          }
        },
      );
    },
    runAgentTask: async (input) =>
      await observeGantryAgentSpan<GantryAgentTaskResult>(
        {
          operationName: 'runAgentTask',
          taskType: input.taskType,
          correlationId: input.correlationId ?? null,
          input: {
            taskType: input.taskType,
            input: input.input,
            maxSteps: input.maxSteps,
          },
          output: (result: GantryAgentTaskResult) => ({
            status: result.status,
            step_count: result.steps.length,
            warning_count: result.warnings?.length ?? 0,
          }),
          observability: input.observability,
        },
        async () => runGenericAgentTask(runnerConfig, input),
      ),
  };
}

async function collectStructuredToolContext(
  tools: StructuredToolProviderSet,
  input: GantryStructuredTaskInput,
): Promise<Record<string, unknown> | null> {
  const toolRequests = asRecord(input.input.toolRequests);
  if (!toolRequests) {
    return null;
  }

  const context: Record<string, unknown> = {};
  const searchRequests = Array.isArray(toolRequests.search)
    ? toolRequests.search
    : [];
  if (tools.search && searchRequests.length > 0) {
    const searchTool = tools.search;
    context.search = await Promise.all(
      searchRequests.map(async (request) => {
        const record = asRecord(request) ?? {};
        const query = readString(record, 'query') ?? '';
        if (!query.trim()) return { error: 'search_query_required' };
        try {
          const result = await searchTool.search({
            query,
            limit: readNumber(record, 'limit') ?? undefined,
            budget: asRecord(record.budget) ?? undefined,
            correlationId: input.correlationId ?? null,
          });
          return { query, ...result };
        } catch (error) {
          return {
            query,
            toolFailure: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  const fetchRequests = Array.isArray(toolRequests.fetch)
    ? toolRequests.fetch
    : [];
  if (tools.fetch && fetchRequests.length > 0) {
    const fetchTool = tools.fetch;
    context.fetch = await Promise.all(
      fetchRequests.map(async (request) => {
        const record = asRecord(request) ?? {};
        const url = readString(record, 'url') ?? '';
        if (!url.trim()) return { error: 'fetch_url_required' };
        try {
          const result = await fetchTool.fetch({
            url,
            budget: asRecord(record.budget) ?? undefined,
            correlationId: input.correlationId ?? null,
          });
          return { requestedUrl: url, ...result };
        } catch (error) {
          return {
            requestedUrl: url,
            toolFailure: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  const mapRequests = Array.isArray(toolRequests.map) ? toolRequests.map : [];
  if (tools.map && mapRequests.length > 0) {
    const mapTool = tools.map;
    context.map = await Promise.all(
      mapRequests.map(async (request) => {
        const record = asRecord(request) ?? {};
        const url = readString(record, 'url') ?? '';
        if (!url.trim()) return { error: 'map_url_required' };
        try {
          const result = await mapTool.map({
            url,
            limit: readNumber(record, 'limit') ?? undefined,
            budget: asRecord(record.budget) ?? undefined,
            correlationId: input.correlationId ?? null,
          });
          return { requestedUrl: url, ...result };
        } catch (error) {
          return {
            requestedUrl: url,
            toolFailure: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  const crawlRequests = Array.isArray(toolRequests.crawl)
    ? toolRequests.crawl
    : [];
  if (tools.crawl && crawlRequests.length > 0) {
    context.crawl = await Promise.all(
      crawlRequests.map(async (request) => {
        const record = asRecord(request) ?? {};
        const url = readString(record, 'url') ?? '';
        if (!url.trim()) return { error: 'crawl_url_required' };
        try {
          const result = await tools.crawl?.crawl({
            url,
            limit: readNumber(record, 'limit') ?? undefined,
            budget: asRecord(record.budget) ?? undefined,
            correlationId: input.correlationId ?? null,
          });
          return { requestedUrl: url, ...(result ?? {}) };
        } catch (error) {
          return {
            requestedUrl: url,
            toolFailure: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  const browserRequests = Array.isArray(toolRequests.browserInspect)
    ? toolRequests.browserInspect
    : [];
  if (tools.browser?.inspect && browserRequests.length > 0) {
    context.browserInspect = await Promise.all(
      browserRequests.map(async (request) => {
        const record = asRecord(request) ?? {};
        const url = readString(record, 'url') ?? '';
        if (!url.trim()) return { error: 'browser_url_required' };
        try {
          const result = await tools.browser?.inspect?.({
            url,
            instructions: readString(record, 'instructions'),
            budget: asRecord(record.budget) ?? undefined,
            correlationId: input.correlationId ?? null,
          });
          return { requestedUrl: url, ...(result ?? {}) };
        } catch (error) {
          return {
            requestedUrl: url,
            toolFailure: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  const documentRequests = Array.isArray(toolRequests.documentExtract)
    ? toolRequests.documentExtract
    : [];
  if (tools.documentExtract && documentRequests.length > 0) {
    context.documentExtract = await Promise.all(
      documentRequests.map(async (request) => {
        const record = asRecord(request) ?? {};
        try {
          return await tools.documentExtract?.extract({
            url: readString(record, 'url'),
            contentType: readString(record, 'contentType'),
            text: readString(record, 'text'),
            budget: asRecord(record.budget) ?? undefined,
            correlationId: input.correlationId ?? null,
          });
        } catch (error) {
          return {
            toolFailure: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  return Object.keys(context).length > 0 ? context : null;
}
