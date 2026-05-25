# Runtime Event Notes

- Runtime event publish/list boundaries must normalize both provider
  conversation ids and provider thread/topic ids before persistence or
  filtering. `runtime_events.thread_id` references canonical
  `conversation_threads.id`; keep raw provider topic ids only inside payload
  metadata.
