"""Stamp-keyed memoisation for the board's repeated disk reads.

The board re-derives everything from disk on every request and polls itself
every few seconds, so the same plan files, event corpus and decision records are
re-read and re-parsed dozens of times a second. This module caches those pure
filesystem reads against a STAMP of their inputs: the cache is reused only while
the files it was built from are byte-for-byte unchanged, so a stale value can
never be served after an edit.

Deliberately a stdlib-only leaf: it imports nothing from `factory_lib` or any
`forge_cli` sibling, so any module can use it without an import cycle.

Stamps use `st_mtime_ns` AND `st_size` AND the entry count, never `st_mtime`:
NTFS only updates last-write-time on the system clock tick (~15.6 ms) and some
filesystems have 2-second granularity, so two rapid writes can share a
timestamp. Size and count catch what the timestamp misses.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

_LOCK = threading.Lock()
_CACHES: dict[str, tuple[Any, Any]] = {}


def file_stamp(path: Path) -> tuple:
    """Identity of one file: (mtime_ns, size), or () when it does not exist."""
    try:
        info = path.stat()
    except OSError:
        return ()
    return (info.st_mtime_ns, info.st_size)


def dir_stamp(directory: Path, suffix: str = "") -> tuple:
    """Identity of a directory's matching entries: the count plus each entry's
    (name, mtime_ns, size). A missing directory stamps distinctly from an empty
    one, so creating it invalidates. One `scandir` — no per-entry `stat` call,
    since `DirEntry.stat()` is served from the directory read on every platform
    the harness runs on."""
    try:
        with os.scandir(directory) as entries:
            found = []
            for entry in entries:
                if suffix and not entry.name.endswith(suffix):
                    continue
                try:
                    info = entry.stat()
                except OSError:
                    continue
                found.append((entry.name, info.st_mtime_ns, info.st_size))
    except OSError:
        return ("<missing>",)
    found.sort()
    return (len(found), tuple(found))


def tree_stamp(directory: Path, *, limit: int = 20000) -> tuple:
    """Identity of a whole subtree: (files, dirs, total size, newest mtime_ns).

    `dir_stamp` sees only one level, which is the wrong shape for `.factory`:
    almost every state change writes NESTED — a grill lands in
    `stories/<key>/grills/tasks/`, a review in `stories/<key>/reviews/` — and
    touches neither `.factory` nor `.factory/stories`. A one-level stamp
    therefore reports "unchanged" across most of the transitions the board
    exists to report, which is how `next_actions` came to serve a memo from
    before a recorded grill.

    Aggregated rather than per-entry so the stamp stays small on a repo with
    hundreds of event files. `newest` is what catches a write: mtime always
    advances on a real write, and count plus total size catch a same-timestamp
    rename or truncation. `limit` bounds the walk so a pathological tree
    degrades into a cheap always-miss instead of a slow poll.
    """
    files = dirs = total = seen = 0
    newest = 0
    try:
        for parent, subdirs, names in os.walk(directory):
            dirs += len(subdirs)
            for name in names:
                seen += 1
                if seen > limit:
                    return ("<over-limit>", seen)
                try:
                    info = os.stat(os.path.join(parent, name))
                except OSError:
                    continue
                files += 1
                total += info.st_size
                newest = max(newest, info.st_mtime_ns)
    except OSError:
        return ("<missing>",)
    return (files, dirs, total, newest)


def cached(namespace: str, stamp: Any, compute: Callable[[], Any]) -> Any:
    """Return the memo for `namespace` when `stamp` is unchanged, else recompute.

    The value is stored under a single namespace key, so callers that vary by
    repo or location must fold that into the namespace string. Compute runs
    OUTSIDE the lock: it does disk I/O, and holding a global lock across it
    would serialise every board request. A concurrent duplicate compute is
    harmless (both produce the same value); a torn read is not possible because
    the (stamp, value) pair is swapped in as one tuple.
    """
    with _LOCK:
        entry = _CACHES.get(namespace)
    if entry is not None and entry[0] == stamp:
        return entry[1]
    value = compute()
    with _LOCK:
        _CACHES[namespace] = (stamp, value)
    return value


def invalidate_all() -> None:
    """Drop every memo. For tests and for any caller that mutates the tree in a
    way a stamp cannot see."""
    with _LOCK:
        _CACHES.clear()
