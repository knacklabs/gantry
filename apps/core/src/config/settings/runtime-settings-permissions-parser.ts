import path from 'node:path';

import type { RuntimePermissionSettings } from './runtime-settings-types.js';
import { validateEgressDenylistPattern } from '../../shared/egress-policy.js';
import {
  parseBooleanValue,
  parseOptionalStringValue,
  parseStringArrayValue,
} from './runtime-settings-parse-primitives.js';

export function parsePermissionSettings(
  raw: unknown,
): RuntimePermissionSettings {
  const defaults: RuntimePermissionSettings = {
    yoloMode: {
      enabled: true,
      denylist: [],
      denylistPaths: [],
    },
    egress: {
      denylist: [],
    },
    trustedRoots: [],
    autoMode: {},
  };
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('permissions must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'yolo_mode' &&
      key !== 'egress' &&
      key !== 'trusted_roots' &&
      key !== 'auto_mode'
    ) {
      throw new Error(
        `permissions.${key} is not supported. Configure permissions.yolo_mode.*, permissions.egress.*, permissions.trusted_roots, or permissions.auto_mode.*.`,
      );
    }
  }
  const yoloRaw = map.yolo_mode;
  if (
    yoloRaw !== undefined &&
    (typeof yoloRaw !== 'object' || yoloRaw === null || Array.isArray(yoloRaw))
  ) {
    throw new Error('permissions.yolo_mode must be a mapping');
  }
  const yoloMode = (yoloRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(yoloMode)) {
    if (key !== 'enabled' && key !== 'denylist' && key !== 'denylist_paths') {
      throw new Error(
        `permissions.yolo_mode.${key} is not supported. Configure enabled, denylist, or denylist_paths.`,
      );
    }
  }
  const egressRaw = map.egress;
  if (
    egressRaw !== undefined &&
    (typeof egressRaw !== 'object' ||
      egressRaw === null ||
      Array.isArray(egressRaw))
  ) {
    throw new Error('permissions.egress must be a mapping');
  }
  const egress = (egressRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(egress)) {
    if (key !== 'denylist') {
      throw new Error(
        `permissions.egress.${key} is not supported. Configure denylist.`,
      );
    }
  }
  const autoModeRaw = map.auto_mode;
  if (
    autoModeRaw !== undefined &&
    (typeof autoModeRaw !== 'object' ||
      autoModeRaw === null ||
      Array.isArray(autoModeRaw))
  ) {
    throw new Error('permissions.auto_mode must be a mapping');
  }
  const autoMode = (autoModeRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(autoMode)) {
    if (key !== 'model') {
      throw new Error(
        `permissions.auto_mode.${key} is not supported. Configure model.`,
      );
    }
  }
  return {
    yoloMode: {
      enabled: parseBooleanValue(
        yoloMode.enabled,
        'permissions.yolo_mode.enabled',
        defaults.yoloMode.enabled,
      ),
      denylist: parseStringArrayValue(
        yoloMode.denylist,
        'permissions.yolo_mode.denylist',
        defaults.yoloMode.denylist,
      ),
      denylistPaths: parseStringArrayValue(
        yoloMode.denylist_paths,
        'permissions.yolo_mode.denylist_paths',
        defaults.yoloMode.denylistPaths,
      ),
    },
    egress: {
      denylist: parseStringArrayValue(
        egress.denylist,
        'permissions.egress.denylist',
        defaults.egress.denylist,
        validateEgressDenylistPattern,
      ),
    },
    trustedRoots: parseStringArrayValue(
      map.trusted_roots,
      'permissions.trusted_roots',
      defaults.trustedRoots,
      validateTrustedRoot,
    ),
    autoMode: {
      model: parseOptionalStringValue(
        autoMode.model,
        'permissions.auto_mode.model',
      ),
    },
  };
}

function validateTrustedRoot(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error('must be a normalized absolute path');
  }
  return value;
}
