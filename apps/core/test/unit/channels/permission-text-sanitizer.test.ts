import { describe, expect, it } from 'vitest';

import { sanitizeReceiptDetail } from '@core/channels/permission-text-sanitizer.js';

describe('sanitizeReceiptDetail', () => {
  it('shows ordinary long-path commands unchanged', () => {
    const command =
      'grep -rn foo /Users/x/dist.bak-l2prev/x9aB3cD5eF7gH9iJ0kL2mN4pQ6';
    expect(sanitizeReceiptDetail(command)).toBe(command);
  });

  it('shows the command with only the secret span masked', () => {
    const detail = sanitizeReceiptDetail('curl --password=hunter2xxxxxxxx api');
    expect(detail).not.toBeNull();
    expect(detail).toContain('curl');
    expect(detail).toContain('[REDACTED_SECRET]');
    expect(detail).not.toContain('hunter2xxxxxxxx');
  });

  it('drops the detail entirely only when a secret cannot be span-masked', () => {
    const detail = sanitizeReceiptDetail(
      'token= A9xQ7mN2pR5sT8uV1wX4yZ6aB3cD5eF7gH9iJ0kL2',
    );
    expect(detail).toBeNull();
  });
});
