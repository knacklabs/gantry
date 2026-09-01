import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

import { resolveGatewayMemoryInjection } from '../adapters/llm/openai-memory/memory-gateway-injection.js';
import type { AppId } from '../domain/app/app.js';
import type { AgentRunId } from '../domain/events/events.js';
import {
  resolveModelSelectionForWorkload,
  type ModelRouteId,
} from '../shared/model-catalog.js';
import {
  getModelProviderDefinition,
  type ModelProviderDefinition,
} from '../shared/model-provider-registry.js';

const CAPTCHA_MODEL_ALIAS = 'gantry.browser.captcha.solve';

type GatewayLease = Awaited<ReturnType<typeof resolveGatewayMemoryInjection>>;
type CaptchaImage = { imageBase64: string; mimeType: string };
type CaptchaReading = { solved: boolean; answer?: string };
const CAPTCHA_VISION_REQUEST_TIMEOUT_MS = 30_000;
const CAPTCHA_VISION_ROUTE_TIMEOUT_MS = 60_000;
const CAPTCHA_VISION_READING_COUNT = 3;

export async function solveCaptchaVision(
  input: {
    appId: string;
    imageBase64: string;
    mimeType: string;
    pageUrl?: string;
    signal?: AbortSignal;
  },
  deps: {
    fetchImpl?: typeof fetch;
    acquireGateway?: (input: {
      appId: AppId;
      modelRouteId: ModelRouteId;
      runId: AgentRunId;
    }) => Promise<GatewayLease>;
  } = {},
): Promise<{ solved: boolean; answer?: string }> {
  const resolved = resolveModelSelectionForWorkload(
    CAPTCHA_MODEL_ALIAS,
    'chat',
  );
  if (!resolved.ok) throw new Error(resolved.message);
  const images = await captchaImageVariants(input);
  const routeTimeout = AbortSignal.timeout(CAPTCHA_VISION_ROUTE_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, routeTimeout])
    : routeTimeout;
  const answer = await solveCaptchaWithRoute({
    appId: input.appId,
    pageUrl: input.pageUrl,
    signal,
    images,
    resolved,
    fetchImpl: deps.fetchImpl ?? fetch,
    acquireGateway: deps.acquireGateway ?? resolveGatewayMemoryInjection,
  });
  return answer ? { solved: true, answer } : { solved: false };
}

type ResolvedCaptchaRoute = Extract<
  ReturnType<typeof resolveModelSelectionForWorkload>,
  { ok: true }
>;

async function solveCaptchaWithRoute(input: {
  appId: string;
  pageUrl?: string;
  signal?: AbortSignal;
  images: CaptchaImage[];
  resolved: ResolvedCaptchaRoute;
  fetchImpl: typeof fetch;
  acquireGateway: NonNullable<
    Parameters<typeof solveCaptchaVision>[1]
  >['acquireGateway'];
}): Promise<string | null> {
  const provider = getModelProviderDefinition(
    input.resolved.entry.modelRoute.id,
  );
  if (!provider) throw new Error('CAPTCHA vision provider is unavailable.');
  const gateway = await input.acquireGateway!({
    appId: input.appId as AppId,
    modelRouteId: input.resolved.entry.modelRoute.id,
    runId: `captcha-vision:${randomUUID()}` as AgentRunId,
  });
  try {
    const { baseUrl, token } = gatewayProjection(
      provider,
      gateway.injection.env,
    );
    const readings = await Promise.allSettled(
      Array.from({ length: CAPTCHA_VISION_READING_COUNT }, (_, index) =>
        requestCaptchaReading({
          provider,
          model: input.resolved.runnerModel,
          baseUrl,
          token,
          images: input.images,
          pageUrl: input.pageUrl,
          reading: index + 1,
          fetchImpl: input.fetchImpl,
          signal: input.signal,
        }),
      ),
    );
    const candidates = readings.flatMap((reading) =>
      reading.status === 'fulfilled' &&
      reading.value.solved &&
      reading.value.answer
        ? [reading.value.answer]
        : [],
    );
    const consensus = captchaConsensus(candidates);
    if (consensus) return consensus;
    const distinctCandidates = [...new Set(candidates)];
    if (distinctCandidates.length < 2) return null;
    const adjudicated = await requestCaptchaReading({
      provider,
      model: input.resolved.runnerModel,
      baseUrl,
      token,
      images: input.images,
      pageUrl: input.pageUrl,
      reading: CAPTCHA_VISION_READING_COUNT + 1,
      candidates: distinctCandidates,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
    return adjudicated.solved &&
      adjudicated.answer &&
      distinctCandidates.includes(adjudicated.answer)
      ? adjudicated.answer
      : null;
  } finally {
    await gateway.revoke();
  }
}

function captchaConsensus(candidates: string[]): string | null {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const count = (counts.get(candidate) ?? 0) + 1;
    if (count >= 2) return candidate;
    counts.set(candidate, count);
  }
  return null;
}

async function requestCaptchaReading(input: {
  provider: ModelProviderDefinition;
  model: string;
  baseUrl: string;
  token: string;
  images: CaptchaImage[];
  pageUrl?: string;
  reading: number;
  candidates?: string[];
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<CaptchaReading> {
  const requestTimeout = AbortSignal.timeout(CAPTCHA_VISION_REQUEST_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, requestTimeout])
    : requestTimeout;
  const response = await input.fetchImpl(
    `${input.baseUrl}${captchaEndpoint(input.provider)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(input.provider.id === 'anthropic'
          ? { 'anthropic-version': '2023-06-01' }
          : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        input.provider.id === 'openai'
          ? openAiResponsesRequest(input.model, input)
          : input.provider.id === 'anthropic'
            ? anthropicMessagesRequest(input.model, input)
            : chatCompletionsRequest(input.model, input),
      ),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `CAPTCHA vision request failed with status ${response.status}.`,
    );
  }
  const body = (await response.json()) as {
    output_text?: string | null;
    output?: Array<{ content?: Array<{ text?: string | null }> }>;
    content?: Array<{
      type?: string;
      name?: string;
      input?: { solved?: unknown; answer?: unknown };
      text?: string | null;
    }>;
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const anthropicToolResult = body.content?.find(
    (item) => item.type === 'tool_use' && item.name === 'captcha_result',
  )?.input;
  if (anthropicToolResult) return parseCaptchaReading(anthropicToolResult);
  const content =
    body.output_text ??
    body.output?.flatMap((item) => item.content ?? []).find((item) => item.text)
      ?.text ??
    body.choices?.[0]?.message?.content;
  if (!content) return { solved: false };
  try {
    return parseCaptchaReading(
      JSON.parse(content) as { solved?: unknown; answer?: unknown },
    );
  } catch {
    return { solved: false };
  }
}

function parseCaptchaReading(parsed: {
  solved?: unknown;
  answer?: unknown;
}): CaptchaReading {
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  return parsed.solved === true && /^[a-zA-Z0-9]{3,12}$/u.test(answer)
    ? { solved: true, answer }
    : { solved: false };
}

function captchaPrompt(
  pageUrl?: string,
  reading = 1,
  candidates: string[] = [],
): string {
  const origin = pageUrl ? ` on ${new URL(pageUrl).origin}` : '';
  const variants =
    'The attached images are lossless visual variants of the same challenge: original, enlarged color, and enlarged grayscale/contrast when available.';
  const focus =
    candidates.length > 0
      ? `Adjudicate the independent candidate transcriptions ${JSON.stringify(candidates)} against the images and return the single best exact answer; do not vote without checking the glyphs.`
      : reading === 1
        ? 'Read left-to-right and preserve uppercase versus lowercase exactly.'
        : reading === 2
          ? 'Independently re-read every glyph; pay special attention to case and ambiguous pairs such as 0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B, C/c, K/k, P/p, U/u, and Y/y.'
          : reading === 3
            ? 'Compare all visual variants character by character before transcribing.'
            : reading === 4
              ? 'Read from right-to-left first to isolate each glyph, then return the final transcription in normal left-to-right order.'
              : reading === 5
                ? 'Use the cleanest visual variant for each individual glyph and independently verify the total character count.'
                : 'Use the cleanest visual variant for each individual glyph and independently verify the total character count.';
  return `Transcribe only the distorted verification-code glyphs exactly as visible${origin}. ${variants} ${focus} Ignore interference lines, dots, borders, and surrounding page text. Return your best plausible transcription. Use solved=false with an empty answer only when no plausible 3-12 character alphanumeric transcription can be produced; the browser independently verifies the answer.`;
}

function captchaJsonSchema() {
  return {
    type: 'object',
    properties: {
      solved: { type: 'boolean' },
      answer: { type: 'string' },
    },
    required: ['solved', 'answer'],
    additionalProperties: false,
  } as const;
}

function openAiResponsesRequest(
  model: string,
  input: {
    images: CaptchaImage[];
    pageUrl?: string;
    reading: number;
    candidates?: string[];
  },
) {
  return {
    model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: captchaPrompt(input.pageUrl, input.reading, input.candidates),
          },
          ...input.images.map((image) => ({
            type: 'input_image',
            image_url: `data:${image.mimeType};base64,${image.imageBase64}`,
            detail: 'original',
          })),
        ],
      },
    ],
    // CAPTCHA transcription is a latency-sensitive visual classification
    // task. Medium reasoning can consume the entire output budget before any
    // structured answer is emitted, leaving a successful HTTP response with
    // status=incomplete. Disable reasoning so the bounded browser tool gets
    // the transcription in time to submit the same live challenge.
    reasoning: { effort: 'none' },
    max_output_tokens: 128,
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'captcha_result',
        strict: true,
        schema: captchaJsonSchema(),
      },
    },
  };
}

function chatCompletionsRequest(
  model: string,
  input: {
    images: CaptchaImage[];
    pageUrl?: string;
    reading: number;
    candidates?: string[];
  },
) {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: captchaPrompt(input.pageUrl, input.reading, input.candidates),
          },
          ...input.images.map((image) => ({
            type: 'image_url',
            image_url: {
              url: `data:${image.mimeType};base64,${image.imageBase64}`,
            },
          })),
        ],
      },
    ],
    max_completion_tokens: 128,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'captcha_result',
        strict: true,
        schema: captchaJsonSchema(),
      },
    },
  };
}

function anthropicMessagesRequest(
  model: string,
  input: {
    images: CaptchaImage[];
    pageUrl?: string;
    reading: number;
    candidates?: string[];
  },
) {
  return {
    model,
    max_tokens: 128,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: captchaPrompt(input.pageUrl, input.reading, input.candidates),
          },
          ...input.images.map((image) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mimeType,
              data: image.imageBase64,
            },
          })),
        ],
      },
    ],
    tools: [
      {
        name: 'captcha_result',
        description: 'Return the exact CAPTCHA transcription.',
        input_schema: captchaJsonSchema(),
      },
    ],
    tool_choice: { type: 'tool', name: 'captcha_result' },
  };
}

export async function captchaImageVariants(input: {
  imageBase64: string;
  mimeType: string;
}): Promise<CaptchaImage[]> {
  const original = { imageBase64: input.imageBase64, mimeType: input.mimeType };
  try {
    const source = Buffer.from(input.imageBase64, 'base64');
    const metadata = await sharp(source).metadata();
    if (!metadata.width || !metadata.height) return [original];
    const scale = Math.min(8, Math.max(4, Math.ceil(512 / metadata.width)));
    const padded = sharp(source).extend({
      top: 8,
      bottom: 8,
      left: 12,
      right: 12,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
    const width = (metadata.width + 24) * scale;
    const color = await padded
      .clone()
      .resize({ width, kernel: sharp.kernel.lanczos3 })
      .sharpen()
      .png()
      .toBuffer();
    const contrast = await padded
      .clone()
      .resize({ width, kernel: sharp.kernel.nearest })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
    const { data: rgba, info } = await padded
      .clone()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const red = rgba[offset]!;
      const green = rgba[offset + 1]!;
      const blue = rgba[offset + 2]!;
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const isDarkNeutralGlyph = max < 145 && max - min < 55;
      const value = isDarkNeutralGlyph ? 0 : 255;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
    const colorNoiseRemoved = await sharp(rgba, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .resize({ width, kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();
    return [
      original,
      { imageBase64: color.toString('base64'), mimeType: 'image/png' },
      { imageBase64: contrast.toString('base64'), mimeType: 'image/png' },
      {
        imageBase64: colorNoiseRemoved.toString('base64'),
        mimeType: 'image/png',
      },
    ];
  } catch {
    return [original];
  }
}

function gatewayProjection(
  provider: ModelProviderDefinition,
  env: Record<string, string>,
): { baseUrl: string; token: string } {
  const projection = provider.gateway.sdkProjection;
  const baseUrl = env[projection.baseUrlEnv];
  const token = env[projection.tokenEnv];
  if (!baseUrl || !token?.startsWith('gtw_')) {
    throw new Error('CAPTCHA vision gateway projection is unavailable.');
  }
  return { baseUrl, token };
}

function chatCompletionsTail(provider: ModelProviderDefinition): string {
  return provider.id === 'openai' || provider.id === 'openrouter'
    ? '/v1/chat/completions'
    : '/chat/completions';
}

function captchaEndpoint(provider: ModelProviderDefinition): string {
  if (provider.id === 'openai') return '/v1/responses';
  if (provider.id === 'anthropic') return '/v1/messages';
  return chatCompletionsTail(provider);
}
