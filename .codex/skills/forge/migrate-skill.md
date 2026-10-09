---
name: forge-migrate
description: Move a client that copied Forge in (the factory/ layout) to the installed Forge v1, safely, in one pull request.
---

# Move a client to Forge v1

Forge v1 is all new code, so a move is careful and reversible. Follow the steps in order, and
stop and ask the human whenever one fails; never work around it.

## 1. Before you start

- Run `git fetch origin`, then `git status`: the working tree must be clean.
- Finish or drop every open Lite or quickfix window and active task with the copied-in `./forge`.
- Note the old Forge version in `constitution/VENDORED_FROM`; it is the way back.

## 2. Show the plan and get one yes

- Run `forge migrate --dry-run`. It changes nothing: no files, branches or GitHub calls.
- Tell the human in plain English:
  - which copied-in Forge files it deletes (those still exactly as copied in), and that it
    deletes the old records under `.factory/` and the old ledgers under `plans/` (git history
    keeps them);
  - which Forge files the client changed, set aside in `.forge-migrate/kept/` for them to decide;
  - the old verify commands it moves from `.envrc` into forge.toml's `test`, and whether `.envrc`
    goes or, holding lines of their own, is set aside;
  - the office-hours design docs it keeps in `docs/context/` (the rest of `.gstack/` goes), and
    any gstack lines of their own it leaves in `.gitignore` or `.gitattributes`;
  - each converted story, whether its approval carries over (or why not), and which stories are
    already finished, so they need nothing more;
  - the unfinished parts, and any part they must fix (a missing Scope or Done-when item);
  - the Forge version it pins, and the branch protection it turns on after the merge.
- Ask one question: "Move this repo to Forge v1?" Go on only after a yes.

## 3. Run it

- Run `forge migrate`. It works only on its own branch, `forge/migrate-v1`, in its own folder,
  with one commit. The default branch doesn't change.
- If it stops part way, its folder keeps changes that aren't committed, so the next run refuses.
  Look in that folder; if nothing there is the human's, remove it with
  `git worktree remove --force <folder>` and run it again. It never resets work it didn't make.

## 4. Check it, in the forge/migrate-v1 folder

- Run the client's own tests; they must pass as before.
- Run `forge doctor` and fix every row it reports.
- If the plan says AGENTS.md needs you, its text above the Forge block mixes the client's words
  with old Forge instructions that now contradict v1. Show them to the human, and remove the old
  ones only after a yes.

## 5. Review it independently

- Run `forge close migrate-v1`. It opens the pull request with the plan in its description.
- Ask a separate reviewer agent, one that didn't run the move, to read the pull request for:
  - a client file lost, or deleted instead of set aside;
  - a deletion outside the listed Forge paths;
  - an approval carried over that shouldn't be, or the other way round.
- Fix what it finds, then run `forge close migrate-v1` again.

## 6. Merge, then protect

- A human merges the pull request; the agent never merges.
- Run `forge close migrate-v1` once more: it turns on branch protection and says so.
- Run `git fetch origin` and `forge next`: the converted stories show.

## 7. Audit leftovers after the merge

- Question every top-level file and folder, including hidden ones. Keep one only when you can
  name its reader: the new Forge's code, a test, CI, forge.toml, or a doc people use. Check inside
  surviving folders for old Forge files that the migration's fixed list could not know about.
- Never delete binary files; list them for the owner.
- Ask the owner one question with options before deleting product history (decisions, specs,
  briefs, and design docs): keep and link it from a current doc, or delete it. Recommend the option
  supported by the reader audit and wait for their choice.
- In one cleanup fix, delete files nothing reads, rewrite docs that describe the old Forge, and
  trim dead .gitignore and .gitattributes rules. Include the README, old roadmap items, and
  unlinked decisions and specs in the audit. Check config for paths to deleted folders and remove
  or update those references.
- Settle every file in `.forge-migrate/kept/`: put each still-used client change in its proper
  home or delete it under the rules above. Settle any other files left under `.forge-migrate/`,
  including replan drafts, then remove .forge-migrate/ from the cleanup fix.

## Going back

- Before the merge: close the pull request. Nothing else changed.
- After the merge: `git revert` the merge in a new pull request, and the copied-in Forge and its
  records are back as they were.
