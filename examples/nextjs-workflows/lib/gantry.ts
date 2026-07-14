import { createClient } from '@gantry/sdk';
import OpenAI from 'openai';

let gantryClient: ReturnType<typeof createClient> | undefined;
let openAIClient: OpenAI | undefined;

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function getGantryClient() {
  return (gantryClient ??= createClient({
    apiKey: requiredEnv('GANTRY_API_KEY'),
    baseUrl: requiredEnv('GANTRY_BASE_URL'),
  }));
}

export function getOpenAIClient() {
  return (openAIClient ??= new OpenAI({
    apiKey: requiredEnv('GANTRY_API_KEY'),
    baseURL: `${requiredEnv('GANTRY_BASE_URL').replace(/\/+$/, '')}/llm/v1`,
  }));
}
