export interface GantryControlClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface GantryHostTaskTarget {
  readonly kind: 'host_task';
  readonly executorId: string;
  readonly inputRef: string;
}

export interface GantryCreateJobInput {
  readonly name: string;
  readonly prompt?: string;
  readonly idempotencyKey?: string;
  readonly target?: GantryHostTaskTarget;
  readonly kind?: 'manual' | 'once' | 'recurring';
  readonly executionContext: {
    readonly conversationJid: string;
    readonly threadId?: string | null;
    readonly workspaceKey: string;
    readonly sessionId: string;
  };
  readonly notificationRoutes?: Array<{
    readonly conversationJid: string;
    readonly threadId?: string | null;
    readonly label: string;
  }>;
}

export interface GantryCreateJobResult {
  readonly jobId?: string;
  readonly status?: string;
  readonly setup?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface GantryTriggerJobResult {
  readonly triggerId: string;
  readonly runId?: string | null;
  readonly [key: string]: unknown;
}

export class GantryControlClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: GantryControlClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    if (!this.baseUrl) throw new Error('Gantry Control baseUrl is required.');
    if (!config.apiKey.trim())
      throw new Error('Gantry Control apiKey is required.');
  }

  async createJob(input: GantryCreateJobInput): Promise<GantryCreateJobResult> {
    return await this.postJson('/v1/jobs', input);
  }

  async triggerJob(jobId: string): Promise<GantryTriggerJobResult> {
    return await this.postJson(
      `/v1/jobs/${encodeURIComponent(jobId)}/trigger`,
      {},
    );
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = text ? parseJson(text) : {};
      if (!response.ok) {
        throw new Error(
          `Gantry Control ${path} failed (${response.status}): ${text.slice(0, 500)}`,
        );
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createGantryControlClient(
  config: GantryControlClientConfig,
): GantryControlClient {
  return new GantryControlClient(config);
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
