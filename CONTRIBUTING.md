# Contributing

Thanks for helping improve Gantry.

## Before You Start

- Open an issue or draft PR for non-trivial changes.
- Keep changes small and focused.
- Avoid unrelated cleanup in the same PR.
- Do not include secrets, customer data, or private deployment details.

## Development

Use Node `>=24 <26` and npm.

```bash
npm install
npm test
```

For larger runtime changes, also run:

```bash
npm run build
```

## Pull Requests

- Explain the problem and the fix.
- Include tests or explain why the change is metadata/docs only.
- Update public docs when behavior changes.
- Keep the CLI binary name `gantry` unless the package contract changes.
