# Authentication and access operations

## Local workstation

Local authentication is loopback-only. Start the full Control profile on the
same origin as `authentication.canonical_origin` (the default is
`http://127.0.0.1:3939`):

```sh
GANTRY_PROCESS_ROLE=control GANTRY_CONTROL_HOST=127.0.0.1 GANTRY_CONTROL_PORT=3939 gantry start
```

Then run `gantry ui`. It prints a one-time URL. The URL expires after ten
minutes and can be used once.

Use `gantry ui authorize` to add another browser. Never paste its fragment
token into tickets, chat, shell history, or logs.

## Hosted setup

Keep the OIDC client secret in a runtime secret source, such as
`GOOGLE_OIDC_CLIENT_SECRET` in the runtime `.env`, and store only its reference
in settings. Initial hosted settings require an active provider:

```yaml
authentication:
  mode: hosted
  canonical_origin: https://gantry.example.com
  active_oidc:
    issuer: https://accounts.google.com
    client_id: your-client-id
    client_secret_ref: env:GOOGLE_OIDC_CLIENT_SECRET
    company_domain: example.com
    provider_label: Google
```

Register this callback URL with the provider:

`<canonical origin>/auth/oidc/callback`

Stage later provider changes as `candidate_oidc` with the same fields. Test the
candidate from Authentication & Access before activation. The test performs a
real OIDC authorization and callback validation without changing the active
runtime configuration or creating a Person, grant, or session. A failed test
preserves the active configuration. Activation appends a settings revision
that promotes the candidate and requires recent reauthentication.

## Hosted proxy and cache

Run the full Control profile behind the public HTTPS proxy. Route `/ui`,
`/auth/*`, `/ui/api/auth/*`, and the authentication event stream to the same
Gantry origin. Preserve Gantry's response headers: never cache authentication
responses, the HTML shell, or browser API responses marked `Cache-Control:
no-store`; disable proxy buffering for the event stream. Hashed static assets
may follow their upstream immutable cache headers.

Keep the Control server private behind the proxy. If `/v1/*` is exposed on a
separate hostname, it remains Bearer-only and must reject browser-session
cookies. Apply a matching outer limit of 20 login and invitation requests per
source IP per minute; Gantry also caps requests by its direct network peer.

## First or lost Administrator

An unapproved OIDC identity sees a 15-minute `GNT-...` access reference on the
no-access page. From trusted deployment access, approve it explicitly:

```sh
gantry auth access approve GNT-0123456789 --role administrator
```

The command resolves the hashed reference, prints the Person and verified
identity summary, and asks for confirmation before transactionally writing the
grant and safe audit event. It never accepts raw SQL or exposes a token, raw
claim, client secret, PKCE verifier, or upstream error. Use the same flow with
`--role viewer` when Administrator access is not required.

## Broken OIDC recovery

Do not add a recovery cookie, public recovery route, or OIDC bypass. From
trusted runtime access, inspect `gantry settings revisions list`, correct a
known-good settings file and secret reference, then import it as a new revision:

```sh
gantry settings import --file /path/to/known-good-settings.yaml --expected-revision <current>
```

Restart only if the settings command reports that it is required, then sign in
again. Candidate test failures need no rollback because they never change the
active configuration.
