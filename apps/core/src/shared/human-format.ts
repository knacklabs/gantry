export interface DurationFormatOptions {
  compactMinutes?: boolean;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const durationMs = Math.max(0, ms);
  if (durationMs > 0 && durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    if (seconds === 0) return `${totalMinutes} min`;
    return `${totalMinutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

export interface RunLabelInput {
  id: string;
  shortId?: number | string | null;
  short_id?: number | string | null;
  attempt?: number | string | { current?: number; total?: number } | null;
  attemptTotal?: number | null;
  attempt_total?: number | null;
  startedAt?: string | Date | null;
  started_at?: string | Date | null;
  nowMs?: number;
}

export function formatRunShortId(
  run: Pick<RunLabelInput, 'id' | 'shortId' | 'short_id'>,
): string {
  const shortId = run.shortId ?? run.short_id;
  if (shortId !== null && shortId !== undefined && String(shortId).trim()) {
    return `#${String(shortId).trim()}`;
  }
  return `r-${run.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown'}`;
}

export function formatRunLabel(run: RunLabelInput): string {
  const parts: string[] = [];
  const startedAt = run.startedAt ?? run.started_at;
  const startedAgo = startedAt ? formatStartedAgo(startedAt, run.nowMs) : '';
  if (startedAgo) parts.push(`started ${startedAgo} ago`);
  const attempt = formatAttempt(run);
  if (attempt) parts.push(`attempt ${attempt}`);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `Run ${formatRunShortId(run)}${suffix}`;
}

function formatStartedAgo(
  startedAt: string | Date,
  nowMs = Date.now(),
): string {
  const timestamp =
    startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return '';
  return formatDuration(Math.max(0, nowMs - timestamp));
}

function formatAttempt(run: RunLabelInput): string {
  if (
    run.attempt &&
    typeof run.attempt === 'object' &&
    ('current' in run.attempt || 'total' in run.attempt)
  ) {
    const current = run.attempt.current;
    const total = run.attempt.total;
    if (current && total) return `${current}/${total}`;
    if (current) return String(current);
  }
  const attempt = run.attempt;
  if (attempt === null || attempt === undefined || attempt === '') return '';
  const total = run.attemptTotal ?? run.attempt_total;
  return total ? `${attempt}/${total}` : String(attempt);
}
