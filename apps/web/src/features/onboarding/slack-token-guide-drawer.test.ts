import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.join(__dirname, 'slack-token-guide-drawer.tsx'),
  'utf8',
);

describe('SlackTokenGuideDrawer', () => {
  it('recreates the V2 token locations with accessible drawer primitives', () => {
    expect(source).toContain("from '../../ui/primitives/dialog'");
    expect(source).toContain('Where to find the tokens');
    expect(source).toContain('Basic Information → App-Level Tokens');
    expect(source).toContain(
      'OAuth & Permissions → OAuth Tokens for Your Workspace',
    );
    expect(source).toContain('connections:write');
    expect(source).toContain('xapp-1-A0••••••••');
    expect(source).toContain('xoxb-2••••••••••');
    expect(source).toContain('motion-reduce:animate-none');
  });
});
