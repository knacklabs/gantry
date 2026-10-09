"""CI may reuse a successful parent workflow for a commit changing only review records."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote


def run(*args: str) -> str:
    # Resolve PATH first, including the .cmd shims used on Windows.
    return subprocess.run([shutil.which(args[0]) or args[0], *args[1:]], check=True,
                          capture_output=True, text=True).stdout.strip()


def reuse() -> bool:
    parents = run("git", "rev-list", "--parents", "-n", "1", os.environ["HEAD_SHA"]).split()
    if len(parents) != 2:
        return False
    head, parent = parents
    base = os.environ.get("BASE_SHA")
    # A push tests the branch itself. Reuse it for a PR only if its parent already
    # incorporates the current base; otherwise the merge result needs its own suite.
    if base:
        run("git", "merge-base", "--is-ancestor", base, parent)
    paths = run("git", "diff", "--name-only", "--no-renames", parent, head).splitlines()
    if not paths:
        return False
    for path in paths:
        if not re.fullmatch(r"\.factory/(fixes/[^/]+|stories/[^/]+/tasks/[^/]+)\.json", path):
            return False
        before, after = (json.loads(run("git", "show", f"{rev}:{path}"))
                         for rev in (parent, head))
        if not isinstance(before, dict) or not isinstance(after, dict):
            return False
        if not isinstance(after.get("review"), dict) or before.get("review") == after["review"]:
            return False
        # Close saves these alongside its review. The change's contract and all other state
        # must remain identical; a .factory path alone is not enough to skip testing.
        bookkeeping = {"review", "status", "steps", "flagged", "stop"}
        if ({k: v for k, v in before.items() if k not in bookkeeping}
                != {k: v for k, v in after.items() if k not in bookkeeping}):
            return False
    workflow = os.environ["GITHUB_WORKFLOW_REF"].split("@", 1)[0].rsplit("/", 1)[1]
    endpoint = f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/workflows/{quote(workflow)}/runs"
    runs = [json.loads(line) for line in run("gh", "api", "--paginate", "--jq",
                                           ".workflow_runs[]", endpoint, "--method", "GET",
                                           "-f", f"head_sha={parent}", "-f", "per_page=100").splitlines()]
    # Target-event runs check the PR but skip tests, so their success proves nothing here.
    matching = [r for r in runs if r.get("head_sha") == parent
                and (r.get("event") == "push" or r.get("event") == "pull_request"
                     and base and any(pr.get("base", {}).get("sha") == base
                                      and pr.get("head", {}).get("sha") == parent
                                      for pr in r.get("pull_requests", [])))]
    latest = max(matching, key=lambda r: r["id"], default={})
    return latest.get("status") == "completed" and latest.get("conclusion") == "success"


try:
    passed = reuse()
except (subprocess.CalledProcessError, ValueError, KeyError, TypeError, OSError):
    # Missing history, unreadable records or unavailable GitHub proof runs the full suite.
    passed = False
with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
    output.write(f"reuse={str(passed).lower()}\n")
print("Parent tests passed; only the review record changed." if passed else "Run the test suite.")
