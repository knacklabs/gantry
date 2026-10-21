# Braces security guard

`braces-3.0.3.tgz` retains the upstream `braces@3.0.3` package name, version,
API, and MIT license while adding bounded-recursion checks for
GHSA-vfj7-8cjw-p6xm. The source used to build the tarball is in `vendor/braces/`.

The guard is the runtime-only change from the depth-limit work proposed in
[`micromatch/braces#72`](https://github.com/micromatch/braces/pull/72), reviewed
against downstream commit `305a2e4bfe324bb53c336c1b03387ee1251c926f`. It:

- limits brace and parenthesis parsing to 100 nested levels;
- bounds recursive compile, expand, and stringify walks;
- rejects parent cycles and invalid `maxDepth` or `maxLength` limits.

Rebuild the checked-in tarball from the repository root with:

```sh
npm pack ./vendor/braces --pack-destination ./vendor
```

The lockfile pins the tarball integrity. `npm audit` intentionally continues to
report the original `braces@3.0.3` advisory because upstream has not published a
fixed release; this local guard is a reviewed runtime mitigation, not an
upstream resolution or a scanner suppression.
