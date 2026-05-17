export function validateRuntimeSettingsPatch(patch: unknown): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throwInvalid('settings patch must be an object.');
  }
  assertSupportedPatchKeys(patch as Record<string, unknown>, 'settings', [
    'agent',
    'memory',
    'permissions',
  ]);
  const record = patch as Record<string, unknown>;
  if (record.agent !== undefined) {
    assertPatchObject(record.agent, 'agent');
    const agent = record.agent as Record<string, unknown>;
    assertSupportedPatchKeys(agent, 'agent', [
      'name',
      'defaultModel',
      'oneTimeJobDefaultModel',
      'recurringJobDefaultModel',
    ]);
    assertOptionalString(agent, 'name', 'agent.name');
    assertOptionalString(agent, 'defaultModel', 'agent.defaultModel');
    assertOptionalString(
      agent,
      'oneTimeJobDefaultModel',
      'agent.oneTimeJobDefaultModel',
    );
    assertOptionalString(
      agent,
      'recurringJobDefaultModel',
      'agent.recurringJobDefaultModel',
    );
  }
  if (record.memory !== undefined) {
    assertPatchObject(record.memory, 'memory');
    const memory = record.memory as Record<string, unknown>;
    assertSupportedPatchKeys(memory, 'memory', ['enabled', 'dreaming']);
    assertOptionalBoolean(memory, 'enabled', 'memory.enabled');
    if (memory.dreaming !== undefined) {
      assertPatchObject(memory.dreaming, 'memory.dreaming');
      const dreaming = memory.dreaming as Record<string, unknown>;
      assertSupportedPatchKeys(dreaming, 'memory.dreaming', ['enabled']);
      assertOptionalBoolean(dreaming, 'enabled', 'memory.dreaming.enabled');
    }
  }
  if (record.permissions !== undefined) {
    assertPatchObject(record.permissions, 'permissions');
    const permissions = record.permissions as Record<string, unknown>;
    assertSupportedPatchKeys(permissions, 'permissions', [
      'yoloMode',
      'egress',
    ]);
    validateYoloModePatch(permissions.yoloMode);
    validateEgressPatch(permissions.egress);
  }
}

export function normalizeSettingsStringArray(
  value: unknown,
  field: string,
  validateItem?: (value: string) => string | void,
): string[] {
  if (!Array.isArray(value)) {
    throwInvalid(`${field} must be an array of strings.`);
  }
  return [
    ...new Set(
      value.map((item, index) => {
        if (typeof item !== 'string' || !item.trim()) {
          throwInvalid(`${field}[${index}] must be a non-empty string.`);
        }
        const normalized = item.trim();
        try {
          return validateItem?.(normalized) ?? normalized;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throwInvalid(`${field}[${index}] ${message}.`);
        }
      }),
    ),
  ];
}

function validateYoloModePatch(value: unknown): void {
  if (value === undefined) return;
  assertPatchObject(value, 'permissions.yoloMode');
  const yoloMode = value as Record<string, unknown>;
  assertSupportedPatchKeys(yoloMode, 'permissions.yoloMode', [
    'enabled',
    'denylist',
    'denylistPaths',
  ]);
  assertOptionalBoolean(yoloMode, 'enabled', 'permissions.yoloMode.enabled');
  assertOptionalStringArray(
    yoloMode,
    'denylist',
    'permissions.yoloMode.denylist',
  );
  assertOptionalStringArray(
    yoloMode,
    'denylistPaths',
    'permissions.yoloMode.denylistPaths',
  );
}

function validateEgressPatch(value: unknown): void {
  if (value === undefined) return;
  assertPatchObject(value, 'permissions.egress');
  const egress = value as Record<string, unknown>;
  assertSupportedPatchKeys(egress, 'permissions.egress', ['denylist']);
  assertOptionalStringArray(
    egress,
    'denylist',
    'permissions.egress.denylist',
    validateEgressDenylistPattern,
  );
}

function assertPatchObject(value: unknown, field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwInvalid(`${field} must be an object.`);
  }
}

function assertSupportedPatchKeys(
  record: Record<string, unknown>,
  field: string,
  supported: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!supported.includes(key)) {
      throwInvalid(`${field}.${key} is not supported.`);
    }
  }
}

function assertOptionalString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): void {
  const value = record[key];
  if (value !== undefined && typeof value !== 'string') {
    throwInvalid(`${field} must be a string.`);
  }
}

function assertOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  field: string,
): void {
  const value = record[key];
  if (value !== undefined && typeof value !== 'boolean') {
    throwInvalid(`${field} must be a boolean.`);
  }
}

function assertOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  field: string,
  validateItem?: (value: string) => string | void,
): void {
  const value = record[key];
  if (value === undefined) return;
  normalizeSettingsStringArray(value, field, validateItem);
}

function throwInvalid(message: string): never {
  throw Object.assign(new Error(message), {
    statusCode: 400,
    code: 'INVALID_REQUEST',
  });
}
import { validateEgressDenylistPattern } from '../shared/egress-policy.js';
