async function cdpJsonRequest(
  port: number,
  endpoint: string,
  method = 'GET',
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
  });
  if (!response.ok) {
    throw new Error(`CDP HTTP ${response.status} for ${endpoint}`);
  }
  return response.json();
}

async function cdpTextRequest(
  port: number,
  endpoint: string,
  method = 'GET',
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
  });
  if (!response.ok) {
    throw new Error(`CDP HTTP ${response.status} for ${endpoint}`);
  }
  return response.text();
}

function isInternalChromeTarget(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return (
    normalized.startsWith('chrome://new-tab-page') ||
    normalized.startsWith('chrome://omnibox-popup')
  );
}

async function activateTarget(port: number, targetId: string): Promise<void> {
  await cdpTextRequest(port, `/json/activate/${targetId}`).catch(() => '');
}

async function closeInternalTargets(
  port: number,
  targetIds: string[],
): Promise<void> {
  await Promise.all(
    [...new Set(targetIds)].map((targetId) =>
      cdpTextRequest(port, `/json/close/${targetId}`).catch(() => ''),
    ),
  );
}

async function listPageTargets(
  port: number,
): Promise<Record<string, unknown>[]> {
  const list = await cdpJsonRequest(port, '/json/list');
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const type = typeof row.type === 'string' ? row.type : '';
    return Boolean(id) && (!type || type === 'page');
  }) as Record<string, unknown>[];
}

async function closeInternalPageTargets(port: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const targets = await listPageTargets(port);
    const internalTargets = targets.flatMap((row) => {
      const id = typeof row.id === 'string' ? row.id : '';
      const url = typeof row.url === 'string' ? row.url : '';
      return id && isInternalChromeTarget(url) ? [id] : [];
    });
    if (internalTargets.length === 0) return;
    await closeInternalTargets(port, internalTargets);
  }
}

export async function ensureBrowserTarget(
  port: number,
): Promise<string | undefined> {
  await closeInternalPageTargets(port);
  const pageTargets = await listPageTargets(port);
  if (pageTargets.length > 0) {
    for (const row of pageTargets) {
      const id = typeof row.id === 'string' ? row.id : '';
      const url = typeof row.url === 'string' ? row.url : '';
      if (id && isInternalChromeTarget(url))
        await closeInternalTargets(port, [id]);
    }
    const firstContentPage = pageTargets.find((row) => {
      const url = typeof row.url === 'string' ? row.url : '';
      return !isInternalChromeTarget(url);
    });
    const id =
      firstContentPage && typeof firstContentPage.id === 'string'
        ? firstContentPage.id
        : '';
    if (id) {
      await activateTarget(port, id);
      await closeInternalPageTargets(port);
      return id;
    }
  }

  let created: unknown;
  try {
    created = await cdpJsonRequest(port, '/json/new?about:blank', 'PUT');
  } catch {
    created = await cdpJsonRequest(port, '/json/new?about:blank');
  }
  if (created && typeof created === 'object') {
    const id =
      typeof (created as Record<string, unknown>).id === 'string'
        ? ((created as Record<string, unknown>).id as string)
        : '';
    if (id) {
      await activateTarget(port, id);
      await closeInternalPageTargets(port);
      return id;
    }
  }
  return undefined;
}
