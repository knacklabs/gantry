# Structural Linter Conventions

Five custom linters in `linters/`. Run via `pnpm check:structural`. All must pass before merge.

## check-file-size.ts
- Walks `apps/` and `packages/` source files (.ts, .tsx, .css)
- Excludes: .spec.ts, .int-spec.ts, .sql, .json, .prisma, .md, generated/, dist/
- Flags source files over 200 lines (controllers over 100 lines)
- Error format: `FILE_TOO_LARGE: {file} is {lines} lines (max {max}). Split by responsibility.`

## check-imports.ts
- Walks `apps/api/src/`
- Detects layer by file naming suffix (see code-quality.md naming table)
- Layers: UI/Runtime (5) → Service/Strategy (4) → Repository/Client (3) → Config (2) → Types/DTO (1)
- Flags any import from a higher layer
- Error format: `UPWARD_IMPORT: Layer N file imports layer M`

## check-boundaries.ts
- Detects cross-domain imports (module A importing module B internals)
- Allowed exceptions: `common/`, `config/`, `prisma/`, `health/`, auth guards in `.guard.ts`/`.module.ts`
- Error format: `CROSS_DOMAIN_IMPORT: {source} imports {target} internals`

## check-naming.ts
- Validates all .ts files use approved suffixes from code-quality.md
- Validates .tsx files are PascalCase
- Entry points (`main.ts`, `index.ts`, `openapi.ts`, `seed.ts`) are exempt
- Error format: `NAMING_SUFFIX: "{file}" lacks an approved suffix`

## check-docs.ts
- Validates every file path referenced in AGENTS.md exists on disk
- Flags stale references and broken links
- Skips glob patterns and URLs

## Error Message Quality (Non-Negotiable)

Every violation message must include:
1. Exact file path
2. What was illegally imported / what rule was broken
3. Which rule was broken (error code)
4. What to do instead
5. Link to relevant convention doc

These messages ARE the remediation. An agent reading them should fix the issue without additional context.

## Running

```bash
# All structural checks
pnpm check:structural

# Individual (from root)
tsx linters/check-file-size.ts
tsx linters/check-imports.ts
tsx linters/check-boundaries.ts
tsx linters/check-naming.ts
tsx linters/check-docs.ts
```
