import { describe, expect, it } from 'vitest';

import {
  createLogger,
  type LogRecord,
} from '@core/infrastructure/logging/logger.js';

describe('logger error cause serialization', () => {
  it('includes redacted nested error causes and postgres fields', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      format: 'json',
      sink: { write: (record) => records.push(record) },
    });

    logger.error(
      {
        err: Object.assign(new Error('Failed query with sk-ant-secret'), {
          cause: Object.assign(
            new Error('cached plan must not change result type'),
            {
              code: '0A000',
              detail: 'contains xoxb-secret-token',
            },
          ),
        }),
      },
      'db read failed',
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.context?.err).toMatchObject({
      type: 'Error',
      message: 'Failed query with [REDACTED]',
      cause: {
        type: 'Error',
        message: 'cached plan must not change result type',
        code: '0A000',
        detail: 'contains [REDACTED]',
      },
    });
  });

  it('truncates recursive error causes', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      format: 'json',
      sink: { write: (record) => records.push(record) },
    });
    const err = new Error('recursive');
    Object.assign(err, { cause: err });

    logger.error({ err }, 'recursive error');

    expect(JSON.stringify(records[0]?.context?.err)).toContain(
      '[TRUNCATED_DEPTH]',
    );
  });
});
