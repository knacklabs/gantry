# node-forge signature verification

Gantry now pins upstream **node-forge 1.4.3** through npm and overrides every
transitive copy to that direct dependency. sandbox-runtime uses it to generate
and verify MITM certificates. It is required and is not removed from the runtime.

The security test preserves malformed DigestInfo regression fixtures for
CVE-2026-85393, valid signatures and a sandbox-runtime TLS handshake. They pass
against 1.4.3 in an isolated dependency tree. The advisory still lists no patched
release while its affected range ends at 1.4.0. The upstream 1.4.3 source contains
canonical DER verification. This is verified through the regression tests,
not through a scanner exclusion. Final image scan is still required.

References:
- https://github.com/digitalbazaar/forge/blob/main/CHANGELOG.md
- https://github.com/advisories/GHSA-86w9-cpqp-85rv

The following describes the superseded 1.4.0 backport. Its source/tarball remain
as historical provenance and are no longer installed or copied into the image.

`node-forge-1.4.0.tgz` retains the upstream `node-forge@1.4.0` package name,
version, main entry point, and dual BSD-3-Clause/GPL-2.0 license while
backporting the canonical-DER verification guard for GHSA-86w9-cpqp-85rv.
The package source used to build the tarball is in `vendor/node-forge/`.

The only runtime source change is the `lib/rsa.js` change from open upstream
PR [`digitalbazaar/forge#1159`](https://github.com/digitalbazaar/forge/pull/1159),
commit `db05494352dd3c9a5a07c5270333dcc78866cad2`. It reconstructs canonical
DigestInfo encodings, with and without NULL parameters, and rejects decoded
signature data that differs from both forms.

The upstream PR does not rebuild `dist/*.min.js`. Those browser bundles are
excluded from this Node-only package so consumers cannot load unpatched copies.
Gantry and `@anthropic-ai/sandbox-runtime` load the main `lib/index.js` entry.

Rebuild the checked-in tarball from the repository root with:

```sh
npm pack ./vendor/node-forge --pack-destination ./vendor
```

The lockfile pins the tarball integrity. `npm audit` intentionally continues to
report the original `node-forge@1.4.0` advisory because upstream has not
published this fix. This is a reviewed backport, not an upstream release or a
scanner suppression.
