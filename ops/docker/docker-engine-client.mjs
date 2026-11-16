import http from 'node:http';

export function engine(socketPath, method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: endpoint, timeout: 15_000,
      headers: { 'content-type': 'application/json' } }, res => {
      const parts = []; let length = 0;
      res.on('data', part => { length += part.length; if (length > 4e6) req.destroy(new Error('Docker response too large')); else parts.push(part); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Docker API returned HTTP ${res.statusCode}`));
        const text = Buffer.concat(parts).toString();
        try { resolve(text ? JSON.parse(text) : undefined); } catch { reject(new Error('Invalid Docker response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

