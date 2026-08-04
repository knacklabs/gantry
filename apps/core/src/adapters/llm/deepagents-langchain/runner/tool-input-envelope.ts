import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { toJSONSchema, z } from 'zod';

const ENVELOPE_PROVIDERS = new Set(['gemini']);

export function envelopeToolsForProvider(
  tools: readonly StructuredToolInterface[],
  provider: string,
): StructuredToolInterface[] {
  if (!ENVELOPE_PROVIDERS.has(provider.trim().toLowerCase())) return [...tools];
  return tools.map(envelopeTool);
}

function envelopeTool(original: StructuredToolInterface): StructuredToolInterface {
  const schema = readableSchema(original.schema);
  return tool(
    async ({ json }): Promise<unknown> => {
      let input: unknown;
      try {
        input = JSON.parse(json);
      } catch {
        if (original.name.startsWith('browser_')) {
          return `${original.name} failed: arguments were not valid JSON. Correct the json field and retry.`;
        }
        throw new Error(`${original.name} received invalid JSON arguments.`);
      }
      try {
        return await original.invoke(input as never);
      } catch (error) {
        if (!original.name.startsWith('browser_')) throw error;
        const detail =
          error instanceof Error ? error.message : 'Browser action failed.';
        return `${original.name} failed: ${detail.slice(0, 2_000)} Correct the arguments using the declared schema and retry.`;
      }
    },
    {
      name: original.name,
      description: [
        original.description,
        'Pass arguments in the json field as one JSON-encoded value matching this schema:',
        schema,
      ].join('\n'),
      schema: z.object({
        json: z.string().describe('JSON-encoded arguments for this tool.'),
      }),
    },
  );
}

function readableSchema(schema: StructuredToolInterface['schema']): string {
  try {
    if (schema && typeof schema === 'object' && '_zod' in schema) {
      return JSON.stringify(toJSONSchema(schema as z.ZodType));
    }
    return JSON.stringify(schema);
  } catch {
    return '{"type":"object"}';
  }
}
