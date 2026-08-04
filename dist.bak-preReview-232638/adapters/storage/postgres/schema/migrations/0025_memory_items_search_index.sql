CREATE INDEX IF NOT EXISTS idx_memory_items_search
  ON memory_items USING gin (
    to_tsvector(
      'english',
      key || ' ' ||
      COALESCE(value_json::jsonb->>'value', '') || ' ' ||
      COALESCE(value_json::jsonb->>'why', '')
    )
  );
