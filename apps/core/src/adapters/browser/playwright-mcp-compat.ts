import type { BrowserIpcAction } from '@myclaw/contracts';

import { normalizeBrowserFilePayload } from './browser-artifact-policy.js';

export function normalizePlaywrightMcpPayload(
  toolName: BrowserIpcAction,
  payload: Record<string, unknown>,
  options: { fileAccessRoot: string },
): Record<string, unknown> {
  const fileNormalized = normalizeBrowserFilePayload(
    toolName,
    payload,
    options,
  );
  if (toolName === 'browser_fill_form') {
    return normalizePlaywrightMcpFillFormPayload(fileNormalized);
  }
  return fileNormalized;
}

export function parsePlaywrightMcpTabListText(
  content: unknown,
): Array<Record<string, unknown>> {
  const text = browserTextContent(content);
  if (!text) return [];
  const tabs: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const parsed = parsePlaywrightMcpTabLine(line);
    if (parsed) tabs.push(parsed);
  }
  return tabs;
}

export function isStalePlaywrightMcpSnapshotRefResult(value: unknown): boolean {
  const message =
    value &&
    typeof value === 'object' &&
    (value as { isError?: unknown }).isError
      ? browserTextContent((value as { content?: unknown }).content)
      : errorMessage(value);
  return /Ref .+ not found in the current page snapshot/i.test(message);
}

function normalizePlaywrightMcpFillFormPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields = payload.fields;
  if (!Array.isArray(fields)) return payload;
  return {
    ...payload,
    fields: fields.map((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        return field;
      }
      const row = field as Record<string, unknown>;
      const target = stringValue(row.target);
      const value = row.value;
      if (!target || value === undefined) return field;
      const name = stringValue(row.name) || stringValue(row.element) || target;
      const type = normalizePlaywrightMcpFieldType(row.type, value);
      return {
        ...row,
        target,
        element: stringValue(row.element) || name,
        name,
        type,
        value: normalizePlaywrightMcpFieldValue(value),
      };
    }),
  };
}

function normalizePlaywrightMcpFieldType(
  value: unknown,
  fieldValue: unknown,
): string {
  if (
    value === 'textbox' ||
    value === 'checkbox' ||
    value === 'radio' ||
    value === 'combobox' ||
    value === 'slider'
  ) {
    return value;
  }
  return typeof fieldValue === 'boolean' ? 'checkbox' : 'textbox';
}

function normalizePlaywrightMcpFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value ?? '');
}

function parsePlaywrightMcpTabLine(
  line: string,
): Record<string, unknown> | undefined {
  const match = line.match(/^\s*-\s*(\d+):\s*(.+)$/);
  if (!match) return undefined;
  const index = Number(match[1]);
  if (!Number.isInteger(index)) return undefined;
  const rest = match[2]?.trim() || '';
  const urlMatch = rest.match(/\s((?:https?:\/\/|file:\/\/|about:)[^\s]+)\s*$/);
  const url = urlMatch?.[1] || '';
  if (!url) return undefined;
  const title = url ? rest.slice(0, -url.length).trim() : rest;
  return {
    index,
    title,
    ...(url ? { url } : {}),
  };
}

function browserTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        return '';
      }
      const row = block as Record<string, unknown>;
      return row.type === 'text' && typeof row.text === 'string'
        ? row.text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
