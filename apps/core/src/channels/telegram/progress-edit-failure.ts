import { logger } from '../../infrastructure/logging/logger.js';

function telegramErrorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (!err || typeof err !== 'object') return '';
  const candidate = err as {
    description?: unknown;
    message?: unknown;
    response?: { description?: unknown };
  };
  return [
    candidate.description,
    candidate.message,
    candidate.response?.description,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' | ');
}

export function isTelegramMessageNotModified(err: unknown): boolean {
  return /message is not modified/i.test(telegramErrorText(err));
}

export function isDefinitiveTelegramEditTargetFailure(err: unknown): boolean {
  if (isTelegramMessageNotModified(err)) return false;
  return /message (?:can not|cannot|can't) be edited|message to edit not found|failed to edit message/i.test(
    telegramErrorText(err),
  );
}

function isDefinitiveTelegramEditFailure(err: unknown): boolean {
  if (isTelegramMessageNotModified(err)) return false;
  if (err && typeof err === 'object') {
    const candidate = err as {
      error_code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    if (typeof candidate.error_code === 'number') return true;
    const status =
      candidate.status ?? candidate.statusCode ?? candidate.response?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      return true;
    }
  }
  return isDefinitiveTelegramEditTargetFailure(err);
}

export function retainTelegramProgressHandleAfterEditFailure(input: {
  jid: string;
  err: unknown;
}): void {
  const definitive = isDefinitiveTelegramEditFailure(input.err);
  logger.debug(
    { jid: input.jid, err: input.err },
    definitive
      ? 'Progress lifecycle telegram retained handle after definitive replace-only edit failure'
      : 'Progress lifecycle telegram retained ambiguous replace-only handle after edit failure',
  );
}
