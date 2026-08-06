import type {
  HistoricalAttachmentFetchIdentity,
  HistoricalAttachmentFetchResult,
  HistoricalAttachmentUnreachableEvidence,
} from '../../domain/ports/historical-attachment-fetcher.js';
import { isLikelySlackHtmlResponse } from './inbound-attachment-download.js';

interface SlackFileInfo {
  name?: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
}

interface SlackFileInfoResponse {
  file?: SlackFileInfo;
}

export async function fetchSlackHistoricalAttachment(
  input: {
    identity: HistoricalAttachmentFetchIdentity;
  },
  deps: {
    filesInfo: (fileId: string) => Promise<SlackFileInfoResponse>;
    download: (url: string) => Promise<Response>;
  },
): Promise<HistoricalAttachmentFetchResult> {
  if (
    input.identity.provider !== 'slack' ||
    input.identity.kind !== 'file_id'
  ) {
    return { status: 'unreachable', reason: 'incapable' };
  }

  let info: SlackFileInfoResponse;
  try {
    info = await deps.filesInfo(input.identity.id);
  } catch (error) {
    return classifySlackApiError(error);
  }
  const file = info.file;
  const url = file?.url_private_download || file?.url_private;
  if (!file || !url) {
    return { status: 'unreachable', reason: 'not_found' };
  }

  let response: Response;
  try {
    response = await deps.download(url);
  } catch {
    return { status: 'unreachable', reason: 'network' };
  }
  const failure = await classifySlackDownloadResponse(
    response,
    file.name || file.title || 'attachment.bin',
  );
  if (failure) return failure;

  const reader = response.body?.getReader();
  return {
    status: 'ok',
    content: reader
      ? {
          read: () => reader.read(),
          cancel: (reason?: unknown) => reader.cancel(reason),
        }
      : new Uint8Array(await response.arrayBuffer()),
    ...(file.name || file.title ? { fileName: file.name || file.title } : {}),
    ...(file.mimetype ? { contentType: file.mimetype } : {}),
  };
}

export async function classifySlackDownloadResponse(
  response: Response,
  fileName = 'attachment.bin',
): Promise<Exclude<HistoricalAttachmentFetchResult, { status: 'ok' }> | null> {
  if (isLikelySlackHtmlResponse(response, fileName)) {
    return {
      status: 'unreachable',
      reason: 'unknown',
      providerStatus: response.status,
    };
  }
  if (response.ok) return null;
  const errorCode = await slackDownloadErrorCode(response);
  if (errorCode === 'file_deleted') return { status: 'deleted' };
  return {
    status: 'unreachable',
    ...classifySlackUnreachableEvidence(errorCode, response.status),
  };
}

export function classifySlackApiError(
  error: unknown,
): Exclude<HistoricalAttachmentFetchResult, { status: 'ok' }> {
  const errorCode = slackApiErrorCode(error);
  if (errorCode === 'file_deleted') return { status: 'deleted' };
  return {
    status: 'unreachable',
    ...classifySlackUnreachableEvidence(errorCode, slackApiStatusCode(error)),
  };
}

function slackApiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const data =
    record.data &&
    typeof record.data === 'object' &&
    !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  for (const value of [data?.error, record.error, record.code]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function slackApiStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return undefined;
  }
  const statusCode = (error as Record<string, unknown>).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

async function slackDownloadErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.clone().text()).trim();
    if (!body) return undefined;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const error = (parsed as Record<string, unknown>).error;
        if (typeof error === 'string') return error.trim();
      }
    } catch {
      return body;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function classifySlackUnreachableEvidence(
  errorCode?: string,
  status?: number,
): HistoricalAttachmentUnreachableEvidence {
  const providerStatus = status === undefined ? {} : { providerStatus: status };
  if (errorCode === 'file_not_found') {
    return { reason: 'not_found', ...providerStatus };
  }
  if (errorCode === 'not_visible') {
    return { reason: 'not_visible', ...providerStatus };
  }
  if (errorCode === 'missing_scope') {
    return {
      reason: 'missing_scope',
      scope: 'files:read',
      ...providerStatus,
    };
  }
  if (
    errorCode === 'ratelimited' ||
    errorCode === 'slack_webapi_rate_limited_error' ||
    status === 429
  ) {
    return { reason: 'rate_limit', ...providerStatus };
  }
  if (
    errorCode === 'slack_webapi_request_error' ||
    errorCode === 'slack_webapi_http_error'
  ) {
    return { reason: 'network', ...providerStatus };
  }
  return { reason: 'unknown', ...providerStatus };
}
