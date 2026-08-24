# Web UI

- Keep route/page modules under 300 lines when a real responsibility boundary
  exists; do not split leaf components solely to satisfy a count.
- Put feature-owned SVGs, images, and other source assets in
  `src/assets/<feature>/` and export them from that feature's `index.ts`.
- Import assets from components. Do not embed SVG markup or data-URI assets in
  component source.
