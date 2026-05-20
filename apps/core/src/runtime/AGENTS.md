# Runtime Notes

- Live provider text deltas may contain only whitespace or leading whitespace.
  Runtime streaming must preserve those deltas until the channel stream buffer
  formats the complete visible text.
- OpenRouter catalog models may use either a provider-marked
  `ANTHROPIC_AUTH_TOKEN` or OneCLI's header-rewrite proxy with a placeholder
  token. Keep native Anthropic aliases on the Anthropic credential path.
