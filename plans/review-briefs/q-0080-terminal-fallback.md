# Review brief — lite window Q-0080 (D-0061: terminal notice when the start card was refused)

Facts: captureLifecycleNotification sends "Running: <job>." through channelWiring.sendProgressUpdate. When a sink returns false (e.g. a stale-generation refusal, fixed separately in Q-0079), no identity is stored for the route. updateLifecycleNotification then returned 'unsupported' without sending, and retire() re-called it with the same routes — so the chat received neither message (live run 224d1141).

Contract for this diff:
- With an identity: unchanged (done + replaceOnly edit of the running card).
- Without an identity: send the terminal summary as a FRESH done message (new card identity, next monotonic generation, no replaceOnly); true → 'updated', false → 'unsupported', throw → 'failed'.
- 'unsupported' still means "this channel cannot render progress", so sinks that return false for done messages behave exactly as before.
- Identity cleanup / capturesByRun deletion unchanged.

Focus: double-sending when the start card lands late (the existing 'retires a running card that lands after terminal fallback' path); retire() being invoked twice for the same route; generation ordering of the fresh message vs. a late-landing running card. Ignore style.
