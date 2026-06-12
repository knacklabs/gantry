import { afterEach, describe, expect, it } from 'vitest';

import {
  fixedImageSetupRequiredMessage,
  missingImageCapabilities,
  parseImageCapabilityInventory,
  readImageCapabilityInventory,
} from '@core/shared/worker-image-inventory.js';
import {
  registerWorkerInstance,
  stopWorkerHeartbeat,
} from '@core/jobs/worker-identity.js';
import type { WorkerRegistryRepository } from '@core/domain/ports/worker-coordination.js';

afterEach(() => {
  stopWorkerHeartbeat();
});

describe('parseImageCapabilityInventory', () => {
  it('parses, trims, de-duplicates and sorts capability ids', () => {
    expect(
      parseImageCapabilityInventory(
        JSON.stringify(['  acme.records  ', 'browser', 'acme.records']),
      ),
    ).toEqual(['acme.records', 'browser']);
  });

  it('returns an empty declared inventory for missing or malformed values', () => {
    expect(parseImageCapabilityInventory(undefined)).toEqual([]);
    expect(parseImageCapabilityInventory('')).toEqual([]);
    expect(parseImageCapabilityInventory('not-json')).toEqual([]);
    expect(parseImageCapabilityInventory(JSON.stringify({}))).toEqual([]);
    expect(parseImageCapabilityInventory(JSON.stringify([1, 2]))).toEqual([]);
  });

  it('returns undefined when no image-capabilities env was declared', () => {
    expect(
      readImageCapabilityInventory({} as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('reads the inventory from the image-capabilities env', () => {
    expect(
      readImageCapabilityInventory({
        GANTRY_IMAGE_CAPABILITIES_JSON: JSON.stringify(['skill:release']),
      } as NodeJS.ProcessEnv),
    ).toEqual(['skill:release']);
  });
});

describe('missingImageCapabilities (live/job admission)', () => {
  it('returns selected capabilities not present in the image inventory', () => {
    expect(
      missingImageCapabilities(
        [{ capabilityId: 'acme.records' }, { capabilityId: 'browser.use' }],
        ['browser.use'],
      ),
    ).toEqual(['acme.records']);
  });

  it('admits when all selected capabilities are present', () => {
    expect(
      missingImageCapabilities(
        [{ capabilityId: 'browser.use' }],
        ['browser.use', 'acme.records'],
      ),
    ).toEqual([]);
  });

  it('treats an empty inventory as no selected capabilities available', () => {
    expect(
      missingImageCapabilities([{ capabilityId: 'browser.use' }], []),
    ).toEqual(['browser.use']);
  });

  it('builds a setup-required message naming the missing capabilities', () => {
    expect(fixedImageSetupRequiredMessage(['acme.records'])).toContain(
      'capability is not available in this worker image: acme.records',
    );
    expect(
      fixedImageSetupRequiredMessage(['acme.records', 'browser.use']),
    ).toContain(
      'capabilities are not available in this worker image: acme.records, browser.use',
    );
  });
});

describe('registerWorkerInstance image inventory', () => {
  it('registers the worker with the image capability inventory', async () => {
    const previous = process.env.GANTRY_IMAGE_CAPABILITIES_JSON;
    process.env.GANTRY_IMAGE_CAPABILITIES_JSON = JSON.stringify([
      'browser',
      'acme.records',
    ]);
    const registered: Array<{ id: string; capabilities?: string[] }> = [];
    const registry: WorkerRegistryRepository = {
      registerWorker: async (input) => {
        registered.push({ id: input.id, capabilities: input.capabilities });
      },
      heartbeatWorker: async () => true,
      markStaleWorkersUnhealthy: async () => [],
      listActiveWorkerCapabilities: async () => [],
      getWorker: async () => null,
      listWorkers: async () => [],
      advertiseWorkerCapabilities: async () => true,
    };

    try {
      await registerWorkerInstance(registry);
    } finally {
      if (previous === undefined) {
        delete process.env.GANTRY_IMAGE_CAPABILITIES_JSON;
      } else {
        process.env.GANTRY_IMAGE_CAPABILITIES_JSON = previous;
      }
    }

    expect(registered).toHaveLength(1);
    expect(registered[0].capabilities).toEqual(['acme.records', 'browser']);
  });
});

describe('registerWorkerInstance process role', () => {
  function makeRegistry(
    captured: Array<{ processRole?: string }>,
  ): WorkerRegistryRepository {
    return {
      registerWorker: async (input) => {
        captured.push({ processRole: input.processRole });
      },
      heartbeatWorker: async () => true,
      markStaleWorkersUnhealthy: async () => [],
      listActiveWorkerCapabilities: async () => [],
      getWorker: async () => null,
      listWorkers: async () => [],
      advertiseWorkerCapabilities: async () => true,
    };
  }

  it('passes the supplied process role through to the registry', async () => {
    const captured: Array<{ processRole?: string }> = [];
    await registerWorkerInstance(makeRegistry(captured), {
      processRole: 'job-worker',
    });
    expect(captured).toEqual([{ processRole: 'job-worker' }]);
  });

  it('defaults the process role to "all" when omitted', async () => {
    const captured: Array<{ processRole?: string }> = [];
    await registerWorkerInstance(makeRegistry(captured));
    expect(captured).toEqual([{ processRole: 'all' }]);
  });
});
