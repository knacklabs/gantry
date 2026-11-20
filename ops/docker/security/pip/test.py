#!/usr/bin/env python3
"""Verify the vendored wheel without network access or container mutation."""
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

wheel = Path(__file__).resolve().parents[4] / 'vendor/pip-26.3-py3-none-any.whl'
with zipfile.ZipFile(wheel) as archive:
    versions = {row['name']: row.get('version') for row in json.loads(archive.read('pip/_vendor/bom.cdx.json'))['components']}
    assert versions['setuptools'] == '78.1.1'
    assert versions['msgpack'] == '1.2.4'
    assert versions['urllib3'] == '2.8.0'
    for name, digest, size in csv.reader(io.StringIO(archive.read('pip-26.3.dist-info/RECORD').decode())):
        if digest:
            data = archive.read(name)
            expected = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
            assert digest == expected and int(size) == len(data), name
with tempfile.TemporaryDirectory(prefix='gantry-pip-security-') as tmp:
    subprocess.run([sys.executable, '-m', 'venv', '--without-pip', tmp], check=True)
    python = str(Path(tmp) / 'bin/python')
    env = {**os.environ, 'PYTHONPATH': str(wheel), 'PIP_DISABLE_PIP_VERSION_CHECK': '1'}
    subprocess.run([python, '-m', 'pip', 'install', '--no-index', '--no-deps', '--no-cache-dir', str(wheel)], env=env, check=True)
    env.pop('PYTHONPATH')
    subprocess.run([python, '-m', 'pip', 'check'], env=env, check=True)
    subprocess.run([python, '-m', 'pip', 'debug'], env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run([python, '-c', "from pip._vendor import pkg_resources,msgpack; assert str(pkg_resources.Requirement.parse('example>=1'))=='example>=1'; assert pkg_resources.parse_version('1.2.3')>pkg_resources.parse_version('1.2.2'); assert msgpack.unpackb(msgpack.packb({'a':[1,2]}))=={'a':[1,2]}; print('Vendored APIs passed')"], env=env, check=True)
print('Wheel inventory, all RECORD hashes, isolated pip install/check/debug and vendored APIs passed')
