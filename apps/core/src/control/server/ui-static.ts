import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export function defaultUiDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui');
}

function uiFile(uiDistDir: string, pathname: string): string | null {
  const relativePath = pathname.slice('/ui/'.length);
  try {
    const resolved = path.resolve(uiDistDir, decodeURIComponent(relativePath));
    return resolved.startsWith(`${uiDistDir}${path.sep}`) ? resolved : null;
  } catch {
    return null;
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function handleUiStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  uiDistDir: string,
): boolean {
  if (pathname !== '/ui' && !pathname.startsWith('/ui/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    res.end();
    return true;
  }
  if (pathname === '/ui') {
    res.statusCode = 308;
    res.setHeader('Location', '/ui/');
    res.end();
    return true;
  }

  const requested = uiFile(uiDistDir, pathname);
  const filePath =
    requested && isRegularFile(requested)
      ? requested
      : path.join(uiDistDir, 'index.html');
  if (!isRegularFile(filePath)) return false;

  const isHtmlShell = filePath.endsWith('index.html');
  res.statusCode = 200;
  res.setHeader(
    'content-type',
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
      'application/octet-stream',
  );
  res.setHeader(
    'cache-control',
    isHtmlShell ? 'no-store' : 'public, max-age=31536000, immutable',
  );
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}
