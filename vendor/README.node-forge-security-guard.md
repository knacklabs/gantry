# node-forge signature-verification guard

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
