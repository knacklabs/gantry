# Anthropic Runner Notes

- Runtime continuation input, close sentinels, and interaction-boundary files
  should wake the live query through `RuntimeSignalPump`. Keep the fallback
  timer as missed-event recovery only; do not reintroduce primary sleep/poll
  loops for active live-turn signals.
- Filesystem wake events are not authority. The existing drain, permission,
  session, and SDK query code still decides what each file means and whether it
  can affect the provider stream.
