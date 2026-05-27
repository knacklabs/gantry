// Stateless HTTP client for the Interakt public API.
//
// Endpoint: POST {baseUrl}/public/message/
// Auth:     Basic <API_KEY> (the dashboard already returns a Base64-encoded
//           value — do NOT re-encode user:pass).
// Body:     { countryCode, phoneNumber, type: "Text", data: { message } }
//
// Phase 1 supports free-form text only. Template sends, buttons, media are
// deferred to Phase 2. The exact payload shape for `type: "Text"` is the
// Step-0 spike result — change here if the spike picks a different field.

export class InteraktRateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(retryAfter: string | null | undefined) {
    super('Interakt rate limit exceeded (HTTP 429)');
    this.name = 'InteraktRateLimitError';
    const parsed = Number(retryAfter);
    this.retryAfterSeconds = Number.isFinite(parsed) ? parsed : undefined;
  }
}

export interface InteraktApiOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface SendFreeFormTextInput {
  countryCode: string;
  phoneNumber: string;
  message: string;
}

export interface SendResult {
  id: string;
}

interface InteraktApiResponse {
  result?: boolean;
  id?: string;
  message?: string;
}

export class InteraktApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: InteraktApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendFreeFormText(input: SendFreeFormTextInput): Promise<SendResult> {
    const url = `${this.baseUrl}/public/message/`;
    const body = {
      countryCode: input.countryCode,
      phoneNumber: input.phoneNumber,
      type: 'Text',
      data: { message: input.message },
    };
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      throw new InteraktRateLimitError(res.headers.get('retry-after'));
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Interakt send failed: HTTP ${res.status} ${detail}`);
    }
    const json = (await res.json()) as InteraktApiResponse;
    if (json.result !== true || !json.id) {
      throw new Error(
        `Interakt send rejected: ${json.message ?? 'unknown error'}`,
      );
    }
    return { id: json.id };
  }
}
