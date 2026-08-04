// Deterministic 1KB PNG-ish test attachment for outbound-attachment scenarios.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ATTACHMENT_SIZE_BYTES = 1024;

function attachmentBytes(): Buffer {
  const bytes = Buffer.alloc(ATTACHMENT_SIZE_BYTES);
  PNG_SIGNATURE.copy(bytes, 0);
  for (let i = PNG_SIGNATURE.length; i < bytes.length; i++) {
    bytes[i] = i % 251; // ponytail: fixed pattern, not a valid PNG body; enough for transfer/hash assertions
  }
  return bytes;
}

export interface TestAttachment {
  path: string;
  sha256: string;
}

/** Write the deterministic attachment into `dir`; same bytes (and sha256) every call. */
export function writeTestAttachment(
  dir: string,
  fileName = 'agent-e2e-attachment.png',
): TestAttachment {
  const bytes = attachmentBytes();
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, bytes);
  return {
    path: filePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
