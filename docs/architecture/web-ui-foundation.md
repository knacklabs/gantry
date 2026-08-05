# Web UI foundation boundary

`apps/web` is a source-only Vite/React workspace. Its operator routes use
generic fixture data and browser-memory preview state. It has no runtime
import, server route, API client, authentication, environment variable,
database connection, Docker artifact, or publishing path. Its `/ui` Vite base
path only defines generated client asset paths; it does not make a Gantry
runtime serve those assets.

The workspace is validated separately with `build:web`, `typecheck:web`,
`lint:web`, and `format:check:web`. Standard runtime builds and containers do
not include `apps/web/dist`. A later, separately approved integration PR must
define runtime hosting, authentication, and API boundaries before this UI can
connect to a Gantry deployment. Preview changes reset on reload; only visual
preferences persist locally.
