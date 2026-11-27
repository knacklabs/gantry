# Structured document renderer

Run `node dist/source-documents/renderer/cli.js` in a dedicated child process.
It reads one UTF-8 JSON request until stdin ends. Success writes one JSON result
to stdout. Failure writes `{"error":"DOCUMENT_RENDER_FAILED"}` to stderr and
exits with status 1. It never writes an artifact to disk or returns a local path.

The version-one request and result are declared in `types.ts`. The input accepts
only paragraphs, headings, lists and rectangular tables. Text resembling a URL,
HTML or script stays literal text. The renderer never interprets it or fetches it.
PDF URL access is disabled. Font access is restricted to the six packaged files.

Limits are 512 KiB of JSON, 100,000 total title/content characters, 200 title
characters, 128 filename characters, 1–200 blocks, 100 list items, 20 table
columns and 200 table rows. Unsupported fields and excess values fail instead of
being truncated. Filenames must be basenames with the matching extension.
The binary output limit is 8 MiB. The caller must allow its base64 representation
plus JSON overhead on stdout. The caller owns child timeouts, cancellation,
parallelism limits and artifact persistence.

`fonts/` contains pinned upstream Noto Sans, Noto Sans Devanagari and Noto Sans
Kannada regular and bold faces. Their official upstream revision, download URLs
and SHA-256 hashes are in `fonts/provenance.json`. Their license is in
`fonts/LICENSE`. PDF embeds the fonts it uses. DOCX embeds all six faces so the
recipient need not install them. Unsupported glyphs fail for both formats.
Latin, Greek, Cyrillic, Devanagari and Kannada use the packaged families.

The runtime build must copy `fonts/` beside the compiled modules. The default
location in the runtime image is `/app/dist/source-documents/renderer/fonts`.
Deployment configuration may override it with `GANTRY_DOCUMENT_FONT_DIR`.
Requests cannot override this directory. The rendered JSON includes only the
filename, media type, byte count, SHA-256, renderer version and base64 bytes.

Focused tests are under `apps/core/test/unit/source-documents/renderer/`.
They reopen PDF pages and the DOCX ZIP rather than trusting a filename suffix.
Visual validation uses generated multi-page fixtures with the bundled
LibreOffice and Poppler tools. Those tools are not release dependencies.
