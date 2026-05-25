# Event Domain Notes

- Runtime event id helpers must preserve canonical app graph identifiers.
  Provider thread/topic ids are raw at channel and runner edges, but runtime
  event persistence uses `thread:<provider-jid>:<raw-thread-id>` so Postgres
  foreign keys and cursor filters stay aligned.
