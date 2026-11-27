# pip vendor refresh

The runtime uses upstream **pip 26.3**. It includes msgpack 1.2.4 and urllib3
2.8.0. Its bundled setuptools `pkg_resources` subset still comes from 70.3.0.

`rebuild.py` replaces that actual subset with the code and license from
setuptools **78.1.1**. It adapts imports to pip's existing vendored packaging,
platformdirs and jaraco-text helper. It removes setuptools's external vendor-path
injection. The full setuptools package is not installed. The component inventory
is updated only after the source replacement. Wheel RECORD hashes are regenerated.
No finding is suppressed or removed from inventory without a source change.

Rebuild and test from the repository root:

```sh
python3 ops/docker/security/pip/rebuild.py vendor/pip-26.3-py3-none-any.whl
python3 ops/docker/security/pip/test.py
```

Expected SHA-256:
`d2c2d4586364ffb9f78edaf46a5c51dd92da4fae0fcc3e738ed629b782adff50`.

The Dockerfile installs this wheel and places the identical wheel in
`ensurepip/_bundled`. Newly created Python environments retain the patched seed.
Source hashes and validation scope are in `provenance.json`. The earlier
26.2.2 backport and urllib3 patches are historical files and are no longer used.

Primary references:
- [pip 26.3](https://pypi.org/project/pip/26.3/)
- [msgpack release notes](https://github.com/msgpack/msgpack-python/blob/main/CHANGELOG.md)
- [setuptools advisory](https://github.com/pypa/setuptools/security/advisories/GHSA-5rjg-fvgr-3xxf)
