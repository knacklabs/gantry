import { afterEach, describe, expect, it, vi } from 'vitest';

import { flowLog, isFlowLogEnabled } from '@core/shared/flow-log.js';

describe('flow-log', () => {
  afterEach(() => {
    delete process.env.GANTRY_FLOW_LOG;
  });

  it('isFlowLogEnabled is true only when GANTRY_FLOW_LOG=1', () => {
    delete process.env.GANTRY_FLOW_LOG;
    expect(isFlowLogEnabled()).toBe(false);
    process.env.GANTRY_FLOW_LOG = '1';
    expect(isFlowLogEnabled()).toBe(true);
    process.env.GANTRY_FLOW_LOG = 'true';
    expect(isFlowLogEnabled()).toBe(false);
  });

  it('flowLog emits a tagged structured line only when enabled', () => {
    const logger = { info: vi.fn() };

    delete process.env.GANTRY_FLOW_LOG;
    flowLog(logger, 'mcp.request', { toolName: 'get_order' });
    expect(logger.info).not.toHaveBeenCalled();

    process.env.GANTRY_FLOW_LOG = '1';
    flowLog(logger, 'mcp.request', { toolName: 'get_order' });
    expect(logger.info).toHaveBeenCalledWith(
      { flow: 'mcp.request', toolName: 'get_order' },
      'flow:mcp.request',
    );
  });
});
