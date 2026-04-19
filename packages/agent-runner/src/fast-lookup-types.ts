export interface FastLookupSuccess {
  ok: true;
  query: string;
  kind: 'search' | 'weather';
  source: string;
  summary: string;
  answer?: string;
  location?: string;
  current?: Record<string, string>;
  forecast?: Array<Record<string, string>>;
  results?: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
}

export interface FastLookupFailure {
  ok: false;
  query: string;
  kind: 'search' | 'weather';
  source: string;
  error: string;
}

export type FastLookupResult = FastLookupSuccess | FastLookupFailure;
