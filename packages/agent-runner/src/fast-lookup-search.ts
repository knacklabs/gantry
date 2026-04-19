import type {
  FastLookupResult,
  FastLookupSuccess,
} from './fast-lookup-types.js';

const FAST_LOOKUP_TIMEOUT_MS = 1_500;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'MyClawFastLookup/1.0 (+https://github.com/qwibitai/myclaw)',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(FAST_LOOKUP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'MyClawFastLookup/1.0 (+https://github.com/qwibitai/myclaw)',
      accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
    },
    signal: AbortSignal.timeout(FAST_LOOKUP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  return response.text();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    );
}

function collapseHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pushRelatedTopic(
  target: FastLookupSuccess['results'],
  value: unknown,
): void {
  if (!Array.isArray(target) || !isPlainObject(value)) return;

  const title = normalizeText(value.Text);
  const url = normalizeText(value.FirstURL);
  if (!title || !url) return;

  target.push({ title, url, snippet: title });
}

function collectDuckDuckGoResults(payload: unknown): {
  answer?: string;
  summary?: string;
  results: NonNullable<FastLookupSuccess['results']>;
} {
  if (!isPlainObject(payload)) {
    return { results: [] };
  }

  const answer = normalizeText(payload.Answer) || undefined;
  const summary = normalizeText(payload.AbstractText) || undefined;
  const results: NonNullable<FastLookupSuccess['results']> = [];
  const related = Array.isArray(payload.RelatedTopics)
    ? payload.RelatedTopics
    : [];

  for (const entry of related) {
    if (results.length >= 5) break;
    if (isPlainObject(entry) && Array.isArray(entry.Topics)) {
      for (const nested of entry.Topics) {
        if (results.length >= 5) break;
        pushRelatedTopic(results, nested);
      }
      continue;
    }
    pushRelatedTopic(results, entry);
  }

  return { answer, summary, results };
}

async function runWikipediaSearch(query: string): Promise<FastLookupResult> {
  const encoded = encodeURIComponent(query);
  const payload = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&format=json&utf8=1&origin=*`,
  );

  if (!isPlainObject(payload) || !isPlainObject(payload.query)) {
    return {
      ok: false,
      query,
      kind: 'search',
      source: 'wikipedia-search',
      error: 'Wikipedia returned an unexpected response shape.',
    };
  }

  const rows = Array.isArray(payload.query.search) ? payload.query.search : [];
  const results = rows
    .filter(isPlainObject)
    .map((row) => ({
      title: normalizeText(row.title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        normalizeText(row.title).replace(/ /g, '_'),
      )}`,
      snippet: normalizeText(row.snippet).replace(/<[^>]+>/g, ' '),
    }))
    .filter((row) => row.title && row.url)
    .slice(0, 5);

  if (results.length === 0) {
    return {
      ok: false,
      query,
      kind: 'search',
      source: 'wikipedia-search',
      error: 'No quick search results found.',
    };
  }

  return {
    ok: true,
    query,
    kind: 'search',
    source: 'wikipedia-search',
    summary: `Found ${results.length} quick result(s) from Wikipedia search.`,
    results,
  };
}

function parseDuckDuckGoHtmlResults(
  html: string,
): NonNullable<FastLookupSuccess['results']> {
  const results: NonNullable<FastLookupSuccess['results']> = [];
  const normalized = html.replace(/\r/g, '');
  const anchorPattern =
    /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of normalized.matchAll(anchorPattern)) {
    if (results.length >= 5) break;
    const url = decodeHtmlEntities(match[1] || '').trim();
    const title = collapseHtmlText(match[2] || '');
    if (!url || !title) continue;

    const afterAnchor = normalized.slice(match.index || 0);
    const snippetMatch = afterAnchor.match(
      /<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i,
    );
    const snippet = snippetMatch
      ? collapseHtmlText(snippetMatch[1])
      : undefined;

    results.push({ title, url, ...(snippet ? { snippet } : {}) });
  }

  return results;
}

async function runDuckDuckGoHtmlSearch(
  query: string,
): Promise<FastLookupResult> {
  const encoded = encodeURIComponent(query);
  const html = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encoded}`,
  );
  const results = parseDuckDuckGoHtmlResults(html);

  if (results.length === 0) {
    return {
      ok: false,
      query,
      kind: 'search',
      source: 'duckduckgo-html-search',
      error: 'No web search results found.',
    };
  }

  return {
    ok: true,
    query,
    kind: 'search',
    source: 'duckduckgo-html-search',
    summary: `Found ${results.length} web search result(s).`,
    results,
  };
}

export async function runSearch(query: string): Promise<FastLookupResult> {
  const encoded = encodeURIComponent(query);
  let duckDuckGoError: string | undefined;
  let parsed: ReturnType<typeof collectDuckDuckGoResults> = { results: [] };

  try {
    const payload = await fetchJson(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
    );
    parsed = collectDuckDuckGoResults(payload);
  } catch (err) {
    duckDuckGoError = err instanceof Error ? err.message : String(err);
  }

  if (parsed.answer || parsed.summary || parsed.results.length > 0) {
    const summary =
      parsed.answer ||
      parsed.summary ||
      `Found ${parsed.results.length} quick result(s) from DuckDuckGo Instant Answer.`;

    return {
      ok: true,
      query,
      kind: 'search',
      source: 'duckduckgo-instant-answer',
      summary,
      ...(parsed.answer ? { answer: parsed.answer } : {}),
      ...(parsed.results.length > 0 ? { results: parsed.results } : {}),
    };
  }

  try {
    const htmlResult = await runDuckDuckGoHtmlSearch(query);
    if (htmlResult.ok) return htmlResult;
  } catch (err) {
    duckDuckGoError =
      duckDuckGoError || (err instanceof Error ? err.message : String(err));
  }

  const wikipediaResult = await runWikipediaSearch(query);
  if (wikipediaResult.ok) {
    return wikipediaResult;
  }

  return {
    ok: false,
    query,
    kind: 'search',
    source: wikipediaResult.source,
    error: duckDuckGoError || wikipediaResult.error,
  };
}
