import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';

import { normalizeBrowserFilePayload } from './browser-artifact-policy.js';

export function normalizeBrowserDirectPayload(
  toolName: BrowserBackendAction,
  payload: Record<string, unknown>,
  options: { fileAccessRoot: string },
): Record<string, unknown> {
  const fileNormalized = normalizeBrowserFilePayload(
    toolName,
    payload,
    options,
  );
  if (toolName !== 'fill_form') return fileNormalized;
  const fields = fileNormalized.fields;
  if (!Array.isArray(fields)) return fileNormalized;
  return {
    ...fileNormalized,
    fields: fields.map((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        return field;
      }
      const row = field as Record<string, unknown>;
      const target = stringValue(row.target);
      if (!target) return field;
      return {
        ...row,
        target,
        element: stringValue(row.element) || stringValue(row.name) || target,
        name: stringValue(row.name) || stringValue(row.element) || target,
        type: normalizeFieldType(row.type, row.value),
        value: normalizeFieldValue(row.value),
      };
    }),
  };
}

export function formFields(value: unknown): Array<{
  target: string;
  type: string;
  value: string;
}> {
  if (!Array.isArray(value)) {
    throw new Error('fill_form fields must be an array.');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('fill_form field entries must be objects.');
    }
    const row = item as Record<string, unknown>;
    return {
      target: requiredString(row.target, 'target'),
      type: normalizeFieldType(row.type, row.value),
      value: normalizeFieldValue(row.value),
    };
  });
}

function normalizeFieldType(value: unknown, fieldValue: unknown): string {
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

function normalizeFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value ?? '');
}

function requiredString(value: unknown, name: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`Browser action requires ${name}.`);
  return normalized;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
