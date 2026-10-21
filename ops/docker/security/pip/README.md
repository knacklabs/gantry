# pip vendor refresh

The runtime keeps Python's standard `venv` behavior, including its bundled pip
seed. pip 26.2.2 fixes the certifi advisory, but still vendors vulnerable
urllib3 2.7.0 and msgpack 1.1.2. No newer pip release contains both fixes.

`rebuild.py` starts from the checksum-pinned pip 26.2.2 wheel, replaces only
those two vendored libraries with urllib3 2.8.0 and msgpack 1.2.1, applies pip's
own 26.2.2 urllib3 vendoring patches, updates `vendor.txt` and the shipped CycloneDX component inventory, and regenerates the
wheel `RECORD`. It writes deterministic zip metadata so independent rebuilds
produce the same SHA-256. Source URLs, hashes, the pip tag commit, validation,
and the local-backport limitation are recorded in `provenance.json`.

Rebuild from the repository root:

```sh
python3 ops/docker/security/pip/rebuild.py vendor/pip-26.2.2-py3-none-any.whl
shasum -a 256 vendor/pip-26.2.2-py3-none-any.whl
```

Expected artifact SHA-256:
`e2ea38fcf3cac60020a6bce296e7f4af9f729501c8271f0eab202e6d9adb8fd2`.

The Docker build installs this wheel as the runtime pip and copies the same
wheel into `ensurepip/_bundled`; otherwise a new virtual environment would
restore the affected vendor versions.

The setuptools entry is retained: pip includes its pkg_resources subset. The
full setuptools package_index module is not shipped; preserve the advisory for
explicit applicability review rather than deleting the inventory entry.
