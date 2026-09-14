import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.join(__dirname, 'slack-manifest-drawer.tsx'),
  'utf8',
);

describe('SlackManifestDrawer', () => {
  it('uses the shared dialog and copy primitives for the manifest disclosure', () => {
    expect(source).toContain("from '../../ui/primitives/copy-button'");
    expect(source).toContain("from '../../ui/primitives/dialog'");
    expect(source).toContain('<CopyButton');
    expect(source).toContain('What the button sets up in Slack');
    expect(source).toContain('will be allowed to do');
    expect(source).toContain('{manifestJson}');
  });
});
