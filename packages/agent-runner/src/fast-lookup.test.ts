import { afterEach, describe, expect, it, vi } from 'vitest';

import { runFastLookup } from './fast-lookup.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runFastLookup', () => {
  it('routes explicit weather questions to weather lookups', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('wttr.in')) {
          return jsonResponse({
            current_condition: [
              {
                temp_C: '31',
                FeelsLikeC: '34',
                humidity: '62',
                windspeedKmph: '10',
                weatherDesc: [{ value: 'Partly cloudy' }],
              },
            ],
            nearest_area: [{ areaName: [{ value: 'Hyderabad' }] }],
            weather: [{ date: '2026-04-19', maxtempC: '35', mintempC: '26' }],
          });
        }
        throw new Error(`unexpected url ${href}`);
      }),
    );

    const result = await runFastLookup('lookup', 'weather today in Hyderabad');

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('weather');
    if (result.ok) {
      expect(result.location).toBe('Hyderabad');
      expect(result.current?.temperatureC).toBe('31');
    }
  });

  it('does not misroute non-weather wind queries into weather lookups', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('api.duckduckgo.com')) {
          return jsonResponse({
            Answer: 'Wind energy is a renewable energy source.',
            RelatedTopics: [],
          });
        }
        if (href.includes('wikipedia.org')) {
          return jsonResponse({
            query: {
              search: [],
            },
          });
        }
        throw new Error(`unexpected url ${href}`);
      }),
    );

    const result = await runFastLookup('lookup', 'wind energy market share');

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('search');
    if (result.ok) {
      expect(result.summary).toContain('Wind energy');
    }
  });

  it('falls back to wikipedia search when duckduckgo has no quick answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('api.duckduckgo.com')) {
          return jsonResponse({
            Answer: '',
            AbstractText: '',
            RelatedTopics: [],
          });
        }
        if (href.includes('wikipedia.org')) {
          return jsonResponse({
            query: {
              search: [
                {
                  title: 'OpenAI',
                  snippet: 'AI research and deployment company',
                },
              ],
            },
          });
        }
        throw new Error(`unexpected url ${href}`);
      }),
    );

    const result = await runFastLookup('search', 'OpenAI');

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('search');
    if (result.ok) {
      expect(result.source).toBe('wikipedia-search');
      expect(result.results?.[0]?.title).toBe('OpenAI');
    }
  });

  it('uses duckduckgo html results before wikipedia when instant answers are empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('api.duckduckgo.com')) {
          return jsonResponse({
            Answer: '',
            AbstractText: '',
            RelatedTopics: [],
          });
        }
        if (href.includes('html.duckduckgo.com')) {
          return new Response(
            `
              <html>
                <body>
                  <a class="result-link" href="https://www.iplt20.com/match/2026">IPL 2026 Match Results</a>
                  <td class="result-snippet">Latest scoreboard and points table update</td>
                </body>
              </html>
            `,
            {
              status: 200,
              headers: { 'content-type': 'text/html' },
            },
          );
        }
        throw new Error(`unexpected url ${href}`);
      }),
    );

    const result = await runFastLookup('search', 'yesterday IPL match result');

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('search');
    if (result.ok) {
      expect(result.source).toBe('duckduckgo-html-search');
      expect(result.results?.[0]?.title).toBe('IPL 2026 Match Results');
      expect(result.results?.[0]?.snippet).toContain('Latest scoreboard');
    }
  });

  it('reports weather failure metadata correctly for lookup-mode weather queries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('wttr.in')) {
          throw new Error('weather timeout');
        }
        throw new Error(`unexpected url ${href}`);
      }),
    );

    const result = await runFastLookup('lookup', 'weather today in Hyderabad');

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('weather');
    expect(result.source).toBe('wttr.in');
    if (!result.ok) {
      expect(result.error).toContain('weather timeout');
    }
  });

  it('rejects multiline or oversized queries before external lookup', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runFastLookup(
      'search',
      `top secret\n${'x'.repeat(20)}`,
    );

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toContain('single short line');
    }
  });
});
