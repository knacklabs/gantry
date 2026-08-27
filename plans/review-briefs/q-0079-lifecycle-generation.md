# Review brief — lite window Q-0079 (scheduled-job "Running…" card silently dropped)

Live evidence (2026-08-25): run 224d1141 produced "Progress lifecycle channel-wiring send attempt" → "send complete" 1 ms apart with NO Telegram send/edit/drop line. The Telegram sink's `shouldAcceptProgressUpdate` (channel-state.ts) returns false silently when `generation <= sealedGenerationForKey`; the sealed value is the previous DONE run's generation on the same chat/thread key. Generations were `lifecycleGeneration(randomUUID)` = FNV hash → effectively random: 5050318887679272 → 5489145060298117 → 3364113462154106 (dropped). Slack/Discord/Teams sinks gate the same way.

Contract for this diff:
- The lifecycle generation is strictly monotonic per process (`max(Date.now(), last + 1)`) and non-decreasing across restarts (sealed maps are in-memory, so a restart cannot leave a sealed value above a fresh Date.now()).
- `progressCardIdentity` keeps using the random card token; only the numeric `generation` changes.
- No change to the sinks' gates.

Known one-time caveat: a process that sealed a hash-era generation (~5e15) before this deploy would reject Date.now()-era values (~1.7e12) until restart; deploys restart the runtime, so this cannot persist. Do not report it.

Focus: any other producer of `generation` for the same route keys that could now be larger than Date.now() (grep `generation:` producers), same-millisecond collisions across routes/jobs, and the terminal (`done`) path which bypasses the gate by design. Ignore style.
