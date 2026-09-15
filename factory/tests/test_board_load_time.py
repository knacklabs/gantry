"""Why the board took seconds per poll, pinned.

Two costs were paid per request instead of once. A `git fetch` of the trunk
(2.7 s on a real remote): the board's reuse window existed, but `forge next`'s
marker checks went around it, and 15 s against a 4 s poll still fetched on
every fourth poll. And a full parse of the Codex job registry per worktree
root -- 16 roots x 1,250 files on one repo -- for every story drawer refresh.
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from collections import Counter
from pathlib import Path

from test_gates import HARNESS, git, head, repo  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))
import factory_lib as lib  # noqa: E402
from forge_cli import codex_status, fscache  # noqa: E402


def _with_origin(repo: Path, tmp_path: Path) -> str:
    remote = tmp_path / "origin.git"
    proc = subprocess.run(["git", "init", "--bare", str(remote)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    git(repo, "remote", "add", "origin", str(remote))
    trunk = lib.default_trunk_branch(repo)
    git(repo, "push", "-q", "origin", f"{head(repo)}:refs/heads/{trunk}")
    return trunk


def test_a_board_process_reuses_one_trunk_fetch_across_requests(repo, tmp_path, monkeypatch):
    trunk = _with_origin(repo, tmp_path)
    fetches: list[list[str]] = []
    real = subprocess.run

    def spy(argv, *args, **kwargs):
        if list(argv[:2]) == ["git", "fetch"]:
            fetches.append(list(argv))
        return real(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", spy)
    monkeypatch.setattr(lib, "MARKER_FETCH_TTL", 60.0)   # what make_server sets
    lib._TRUNK_FETCH_AT.clear()
    # The path `forge next` takes (refresh=True) -- the one that used to go
    # around the window -- three times, then the board's own per-render path.
    for _ in range(3):
        lib.task_marker_on_main(repo, "ENG-1", "T1")
    lib.fetch_trunk(repo, trunk, ttl=lib.MARKER_FETCH_TTL)
    assert len(fetches) == 1, fetches
    # The refresher's fetch opens a fresh window the requests reuse.
    assert lib.refresh_trunk(repo, trunk) is True
    lib.task_marker_on_main(repo, "ENG-1", "T1")
    assert len(fetches) == 2
    # A CLI process leaves the TTL at zero and stays live: every check fetches.
    monkeypatch.setattr(lib, "MARKER_FETCH_TTL", 0.0)
    lib._TRUNK_FETCH_AT.clear()
    lib.task_marker_on_main(repo, "ENG-1", "T1")
    lib.task_marker_on_main(repo, "ENG-1", "T1")
    assert len(fetches) == 4


def test_the_job_registry_is_parsed_once_for_all_worktree_roots(tmp_path, monkeypatch):
    state = tmp_path / "state"
    roots = [tmp_path / f"wt{i}" for i in range(4)]
    jobs = state / "proj" / "jobs"
    jobs.mkdir(parents=True)
    for i, root in enumerate(roots):
        root.mkdir()
        for n in range(3):
            (jobs / f"job-{i}-{n}.json").write_text(json.dumps({
                "id": f"job-{i}-{n}", "workspaceRoot": str(root),
                "createdAt": f"2020-01-01T00:0{n}:00Z"}), encoding="utf-8")
    (state / "proj" / "state.json").write_text(json.dumps({"jobs": [
        {"id": "job-0-0", "updatedAt": "2021-01-01T00:00:00Z"}]}), encoding="utf-8")

    reads: list[Path] = []
    real = Path.read_text

    def spy(self, *args, **kwargs):
        if self.suffix == ".json" and state in self.parents:
            reads.append(self)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", spy)
    fscache.invalidate_all()
    found = {root: codex_status.load_jobs(root, state) for root in roots}
    assert all(len(v) == 3 for v in found.values())
    assert [j["id"] for j in found[roots[1]]] == ["job-1-0", "job-1-1", "job-1-2"]
    assert found[roots[0]][0]["updatedAt"] == "2021-01-01T00:00:00Z"  # state.json merged
    assert found[roots[0]][0]["_path"] == jobs / "job-0-0.json"
    # Twelve job files and one state.json: each read once, not once per root.
    assert len(reads) == 13, [p.name for p in reads]
    # A registry change is still seen without a restart.
    (jobs / "job-2-9.json").write_text(json.dumps({
        "id": "job-2-9", "workspaceRoot": str(roots[2]),
        "createdAt": "2020-01-02T00:00:00Z"}), encoding="utf-8")
    assert [j["id"] for j in codex_status.load_jobs(roots[2], state)][-1] == "job-2-9"
    assert codex_status.load_jobs(tmp_path / "elsewhere", state) == []

def _count_git(monkeypatch, verbs: tuple[str, ...]) -> Counter:
    seen: Counter = Counter()
    real = subprocess.run

    def spy(argv, *args, **kwargs):
        if list(argv[:1]) == ["git"] and len(argv) > 1 and argv[1] in verbs:
            seen[argv[1]] += 1
        return real(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", spy)
    return seen


def test_board_memo_reuses_git_facts_until_the_files_that_decide_them_change(
        repo, tmp_path, monkeypatch):
    trunk = _with_origin(repo, tmp_path)
    git(repo, "fetch", "-q", "origin")
    seen = _count_git(monkeypatch, ("cat-file", "remote", "ls-tree", "ls-files"))
    fscache.invalidate_all()
    monkeypatch.setattr(lib, "BOARD_MEMO", True)

    # Shipped marker: asked twice, answered once; the ref moving re-asks.
    assert lib.task_marker_on_main(repo, "ENG-1", "T1", refresh=False) is False
    assert lib.task_marker_on_main(repo, "ENG-1", "T1", refresh=False) is False
    assert seen["cat-file"] == 1
    marker = repo / lib.task_marker_path("ENG-1", "T1")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("{}", encoding="utf-8")
    git(repo, "add", "-f", str(marker.relative_to(repo)))
    git(repo, "commit", "-qm", "ship T1")
    git(repo, "push", "-q", "origin", f"HEAD:refs/heads/{trunk}")
    git(repo, "fetch", "-q", "origin")
    assert lib.task_marker_on_main(repo, "ENG-1", "T1", refresh=False) is True
    assert seen["cat-file"] == 2

    # Origin: asked twice, answered once. (`remote` also counts the one`n    # `git remote show` the trunk-branch lookup made above.)
    remote_before = seen["remote"]
    assert lib._has_origin(repo) and lib._has_origin(repo)
    assert seen["remote"] == remote_before + 1

    # A commit's tree is fixed by its id; the index digest follows the index.
    sha = head(repo)
    assert lib.product_tree_digest(repo, sha) == lib.product_tree_digest(repo, sha)
    assert seen["ls-tree"] == 1
    before = lib.product_tree_digest(repo)
    assert lib.product_tree_digest(repo) == before and seen["ls-files"] == 1
    (repo / "src" / "memo_probe.py").parent.mkdir(parents=True, exist_ok=True)
    (repo / "src" / "memo_probe.py").write_text("x = 1\n", encoding="utf-8")
    git(repo, "add", "src/memo_probe.py")
    assert lib.product_tree_digest(repo) != before and seen["ls-files"] == 2

    # A CLI process (BOARD_MEMO off) asks git every time.
    monkeypatch.setattr(lib, "BOARD_MEMO", False)
    lib._has_origin(repo); lib._has_origin(repo)
    assert seen["remote"] == remote_before + 3


def test_a_request_inside_the_window_never_waits_for_the_refresher(tmp_path, monkeypatch):
    calls: list[float] = []
    delay = {"s": 0.0, "ok": True}

    def fake_fetch(root, trunk):
        calls.append(time.monotonic())
        time.sleep(delay["s"])
        return delay["ok"]

    monkeypatch.setattr(lib, "_fetch_trunk_now", fake_fetch)
    monkeypatch.setattr(lib, "MARKER_FETCH_TTL", 60.0)
    lib._TRUNK_FETCH_AT.clear()
    assert lib.refresh_trunk(tmp_path, "main") is True

    delay["s"] = 1.5
    refresher = threading.Thread(target=lib.refresh_trunk, args=(tmp_path, "main"))
    refresher.start()
    time.sleep(0.2)
    started = time.monotonic()
    assert lib.fetch_trunk(tmp_path, "main") is True
    assert time.monotonic() - started < 0.5, "a fresh request waited on the refresher"
    refresher.join()

    # A failure is reused briefly, then retried.
    delay.update(s=0.0, ok=False)
    lib._TRUNK_FETCH_AT.clear()
    before = len(calls)
    assert lib.fetch_trunk(tmp_path, "main") is False
    assert lib.fetch_trunk(tmp_path, "main") is False
    assert len(calls) == before + 1
    monkeypatch.setattr(lib, "_TRUNK_FETCH_FAILURE_TTL", 0.05)
    time.sleep(0.1)
    lib.fetch_trunk(tmp_path, "main")
    assert len(calls) == before + 2


def test_the_board_reads_the_job_registry_once_for_every_worktree_root(tmp_path, monkeypatch):
    from forge_cli import board

    state = tmp_path / "state"
    roots = [tmp_path / f"wt{i}" for i in range(5)]
    jobs = state / "proj" / "jobs"
    jobs.mkdir(parents=True)
    for i, root in enumerate(roots):
        root.mkdir()
        for n in range(2):
            (jobs / f"job-{i}-{n}.json").write_text(json.dumps({
                "id": f"job-{i}-{n}", "workspaceRoot": str(root), "phase": f"p{n}",
                "createdAt": f"2020-01-01T00:0{n}:00Z"}), encoding="utf-8")
    monkeypatch.setattr(codex_status, "STATE_ROOT", state)
    stamps: list[Path] = []
    real = fscache.tree_stamp

    def spy(directory, *args, **kwargs):
        stamps.append(Path(directory))
        return real(directory, *args, **kwargs)

    monkeypatch.setattr(fscache, "tree_stamp", spy)
    fscache.invalidate_all()
    found = board._codex_jobs_by_root(roots)
    assert [stamp for stamp in stamps if stamp == state] == [state]
    assert {root.resolve(): job["id"] for root, job in found.items()} == {
        root.resolve(): f"job-{i}-1" for i, root in enumerate(roots)}
