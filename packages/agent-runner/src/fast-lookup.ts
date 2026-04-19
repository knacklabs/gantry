import { fileURLToPath } from 'url';
import { runSearch } from './fast-lookup-search.js';
import type { FastLookupResult } from './fast-lookup-types.js';

const FAST_LOOKUP_TIMEOUT_MS = 1_500;

function usage(): string {
  return [
    'Usage:',
    '  node fast-lookup.js lookup "<query>"',
    '  node fast-lookup.js search "<query>"',
    '  node fast-lookup.js weather "<location>"',
  ].join('\n');
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

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractWeatherLocation(query: string): string {
  const simplified = query
    .replace(/[?.,!]/g, ' ')
    .replace(
      /\b(how|what|is|the|today|now|current|currently|right|like|weather|temperature|forecast|humidity|wind|in|for|at)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

  return simplified || query.trim();
}

async function runWeather(query: string): Promise<FastLookupResult> {
  const location = extractWeatherLocation(query);
  const encoded = encodeURIComponent(location);
  const payload = await fetchJson(`https://wttr.in/${encoded}?format=j1`);

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      query,
      kind: 'weather',
      source: 'wttr.in',
      error: 'wttr.in returned an unexpected response shape.',
    };
  }

  const current = Array.isArray(payload.current_condition)
    ? payload.current_condition[0]
    : undefined;
  const nearestArea = Array.isArray(payload.nearest_area)
    ? payload.nearest_area[0]
    : undefined;
  const days = Array.isArray(payload.weather)
    ? payload.weather.slice(0, 2)
    : [];

  if (!isPlainObject(current)) {
    return {
      ok: false,
      query,
      kind: 'weather',
      source: 'wttr.in',
      error: 'No current weather data returned.',
    };
  }

  const resolvedLocation =
    isPlainObject(nearestArea) &&
    Array.isArray(nearestArea.areaName) &&
    isPlainObject(nearestArea.areaName[0])
      ? normalizeText(nearestArea.areaName[0].value)
      : location;

  const condition =
    Array.isArray(current.weatherDesc) && isPlainObject(current.weatherDesc[0])
      ? normalizeText(current.weatherDesc[0].value)
      : '';

  const forecast = days
    .filter(isPlainObject)
    .map((day) => ({
      date: normalizeText(day.date),
      maxTempC: normalizeText(day.maxtempC),
      minTempC: normalizeText(day.mintempC),
      avgTempC: normalizeText(day.avgtempC),
      sunHours: normalizeText(day.sunHour),
    }))
    .filter((day) => day.date);

  return {
    ok: true,
    query,
    kind: 'weather',
    source: 'wttr.in',
    location: resolvedLocation,
    summary: [
      resolvedLocation,
      condition || 'Current weather available',
      normalizeText(current.temp_C) ? `${normalizeText(current.temp_C)}C` : '',
      normalizeText(current.FeelsLikeC)
        ? `feels like ${normalizeText(current.FeelsLikeC)}C`
        : '',
    ]
      .filter(Boolean)
      .join(', '),
    current: {
      temperatureC: normalizeText(current.temp_C),
      feelsLikeC: normalizeText(current.FeelsLikeC),
      humidity: normalizeText(current.humidity),
      windKmph: normalizeText(current.windspeedKmph),
      condition,
    },
    ...(forecast.length > 0 ? { forecast } : {}),
  };
}

function shouldUseWeather(query: string): boolean {
  return [
    /\bweather\b/i,
    /\bforecast\b/i,
    /\btemperature\s+(?:in|for|at)\b/i,
    /\btemperature\b.*\b(?:today|now|outside|right now)\b/i,
    /\brain\s+(?:in|for|at)\b/i,
    /\bhumidity\s+(?:in|for|at)\b/i,
    /\bwind\s+(?:in|for|at)\b/i,
  ].some((pattern) => pattern.test(query));
}

export async function runFastLookup(
  mode: 'lookup' | 'search' | 'weather',
  query: string,
): Promise<FastLookupResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      ok: false,
      query: '',
      kind: mode === 'weather' ? 'weather' : 'search',
      source: 'fast-lookup',
      error: 'Query is required.',
    };
  }

  if (trimmed.length > 240 || /[\r\n]/.test(trimmed)) {
    return {
      ok: false,
      query: trimmed.slice(0, 240),
      kind: mode === 'weather' ? 'weather' : 'search',
      source: 'fast-lookup',
      error:
        'Query must be a single short line (240 characters or fewer) before external lookup.',
    };
  }

  const effectiveMode =
    mode === 'lookup' && shouldUseWeather(trimmed) ? 'weather' : mode;

  try {
    if (effectiveMode === 'weather') {
      return await runWeather(trimmed);
    }
    return await runSearch(trimmed);
  } catch (err) {
    return {
      ok: false,
      query: trimmed,
      kind: effectiveMode === 'weather' ? 'weather' : 'search',
      source:
        effectiveMode === 'weather' ? 'wttr.in' : 'duckduckgo-instant-answer',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv;

  if (!mode || mode === '--help' || mode === '-h') {
    console.error(usage());
    return mode ? 0 : 1;
  }

  if (mode !== 'lookup' && mode !== 'search' && mode !== 'weather') {
    console.error(usage());
    return 1;
  }

  const result = await runFastLookup(mode, rest.join(' '));
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
