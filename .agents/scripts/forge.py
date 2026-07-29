#!/usr/bin/env python3
"""forge — the harness CLI. `./forge <command>` from the repo root.

Commands: doctor, init, adopt, upgrade, next, plan (save|assume),
roadmap (import|list|add), context (scan|list|mark), decision (new|accept).
Implementations live in forge_cli/ — one module per concern; this file is
argument wiring only.
"""
from __future__ import annotations

import argparse

from forge_cli import adopt as adopt_mod
from forge_cli import audit as audit_mod
from forge_cli import assumptions as assumptions_mod
from forge_cli import context as ctx
from forge_cli import deferrals as deferrals_mod
from forge_cli import findings as findings_mod
from forge_cli import lessons as lessons_mod
from forge_cli import scratchpad as scratchpad_mod
from forge_cli import stages as stages_mod
from forge_cli import gstack as gstack_mod
from forge_cli import signal as signal_mod
from forge_cli import decisions, doctor, phase, plans, roadmap, scaffold, team, upgrade


def main() -> None:
    parser = argparse.ArgumentParser(prog="forge", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_doc = sub.add_parser("doctor", help="check machine prerequisites for the harness")
    p_doc.add_argument("--fix", action="store_true",
                       help="auto-install everything installable; logins stay manual")
    p_doc.add_argument("--fast", action="store_true",
                       help="millisecond existence-only check (what the session hook runs)")
    p_doc.set_defaults(func=doctor.cmd_doctor)

    p_next = sub.add_parser("next", help="where am I and what do I do now (deterministic)")
    p_next.add_argument("--repo")
    p_next.set_defaults(func=phase.cmd_next)

    p_init = sub.add_parser("init", help="scaffold a new client repo from this harness")
    p_init.add_argument("--name", required=True)
    p_init.add_argument("--target")
    p_init.add_argument("--stack", default="nestjs-react")
    p_init.add_argument("--force", action="store_true")
    p_init.set_defaults(func=scaffold.cmd_init)

    p_adopt = sub.add_parser("adopt",
                             help="vendor the harness into an EXISTING repo (run from the harness)")
    p_adopt.add_argument("--target", required=True, help="the existing repo to migrate")
    p_adopt.add_argument("--name", help="project name (defaults to the target directory name)")
    p_adopt.set_defaults(func=adopt_mod.cmd_adopt)

    p_up = sub.add_parser("upgrade",
                          help="re-vendor harness machinery into a client repo (run from the harness)")
    p_up.add_argument("--target", required=True, help="the client repo to upgrade")
    p_up.add_argument("--force", action="store_true",
                      help="proceed even if the target has uncommitted changes")
    p_up.set_defaults(func=upgrade.cmd_upgrade)

    p_plan = sub.add_parser("plan", help="manage task plans")
    plan_sub = p_plan.add_subparsers(dest="plan_command", required=True)
    p_save = plan_sub.add_parser("save", help="persist an approved plan into plans/active/")
    p_save.add_argument("--from", dest="source", required=True,
                        help="path to the approved plan file (e.g. the Claude Code plan)")
    p_save.add_argument("--issue", help="issue key (defaults to .factory/run.json)")
    p_save.add_argument("--title", help="plan title (defaults to run.json title)")
    p_save.add_argument("--repo", help="target repo (defaults to this repo)")
    p_save.set_defaults(func=plans.cmd_save)
    p_assume = plan_sub.add_parser(
        "assume", help="record an implementation assumption on the active plan")
    p_assume.add_argument("text", help="the assumption, one sentence")
    p_assume.add_argument("--issue", help="issue key (defaults to .factory/run.json)")
    p_assume.add_argument("--repo")
    p_assume.set_defaults(func=plans.cmd_assume)

    p_rm = sub.add_parser("roadmap", help="the durable project backlog (plans/roadmap.json)")
    rm_sub = p_rm.add_subparsers(dest="roadmap_command", required=True)
    p_imp = rm_sub.add_parser("import",
                              help="record/merge the ordered feature list from a decomposition")
    p_imp.add_argument("--input", required=True,
                       help='JSON: {"items": [{key,title,epic}]} in execution order')
    p_imp.add_argument("--repo")
    p_imp.set_defaults(func=roadmap.cmd_import)
    p_rl = rm_sub.add_parser("list", help="show the roadmap with status")
    p_rl.add_argument("--pending", action="store_true")
    p_rl.add_argument("--repo")
    p_rl.set_defaults(func=roadmap.cmd_list)
    p_ra = rm_sub.add_parser("add", help="append one item to the roadmap")
    p_ra.add_argument("key")
    p_ra.add_argument("title")
    p_ra.add_argument("--epic")
    p_ra.add_argument("--skill", help="frontend | backend | fullstack")
    p_ra.add_argument("--kind", help="feature | refactor (refactor => source-delta ratchet at pr_ready)")
    p_ra.add_argument("--repo")
    p_ra.set_defaults(func=roadmap.cmd_add)
    p_rh = rm_sub.add_parser("heal",
                             help="post-merge convergence: union duplicate items (done-wins), rebuild from merge stages if unparseable")
    p_rh.add_argument("--repo")
    p_rh.set_defaults(func=roadmap.cmd_heal)
    p_rp = rm_sub.add_parser("parallel",
                             help="the fan-out view: unblocked stories that can run concurrently (one worktree each)")
    p_rp.add_argument("--repo")
    p_rp.set_defaults(func=roadmap.cmd_parallel)
    p_ras = rm_sub.add_parser("assign", help="EM distribution: put a dev on a story")
    p_ras.add_argument("key")
    p_ras.add_argument("--to", required=True, help="dev handle (checked against plans/team.json)")
    p_ras.add_argument("--repo")
    p_ras.set_defaults(func=roadmap.cmd_assign)

    p_team = sub.add_parser("team", help="the optional project roster (plans/team.json)")
    team_sub = p_team.add_subparsers(dest="team_command", required=True)
    p_ts = team_sub.add_parser("set", help="add or update a member")
    p_ts.add_argument("handle")
    p_ts.add_argument("--role", help="dev | em | pm (default dev)")
    p_ts.add_argument("--skills", help="comma-separated: frontend,backend or fullstack")
    p_ts.add_argument("--name")
    p_ts.add_argument("--repo")
    p_ts.set_defaults(func=team.cmd_set)
    p_tl = team_sub.add_parser("list", help="show the roster")
    p_tl.add_argument("--repo")
    p_tl.set_defaults(func=team.cmd_list)

    p_ctx = sub.add_parser("context", help="track the docs/context inbox")
    ctx_sub = p_ctx.add_subparsers(dest="context_command", required=True)
    p_scan = ctx_sub.add_parser("scan", help="register new/changed context files in the ledger")
    p_scan.add_argument("--check", action="store_true",
                        help="fail if the ledger is out of sync (CI mode; writes nothing)")
    p_scan.add_argument("--repo")
    p_scan.set_defaults(func=ctx.cmd_scan)
    p_list = ctx_sub.add_parser("list", help="show ledger entries")
    p_list.add_argument("--pending", action="store_true")
    p_list.add_argument("--repo")
    p_list.set_defaults(func=ctx.cmd_list)
    p_mark = ctx_sub.add_parser("mark", help="record harvest outcome for a context file")
    p_mark.add_argument("file")
    group = p_mark.add_mutually_exclusive_group(required=True)
    group.add_argument("--harvested", action="store_true")
    group.add_argument("--ignored", action="store_true")
    p_mark.add_argument("--outputs", nargs="*", help="repo-relative paths the harvest produced")
    p_mark.add_argument("--notes")
    p_mark.add_argument("--repo")
    p_mark.set_defaults(func=ctx.cmd_mark)

    p_as = sub.add_parser("assumptions", help="the implementation assumptions ledger (plans/assumptions.md)")
    as_sub = p_as.add_subparsers(dest="assumptions_command", required=True)
    p_al = as_sub.add_parser("list", help="show the ledger")
    p_al.add_argument("--open", action="store_true", help="only open/fix-needed rows")
    p_al.add_argument("--repo")
    p_al.set_defaults(func=assumptions_mod.cmd_list)
    p_ar = as_sub.add_parser("resolve", help="orchestrator guidance on an assumption")
    p_ar.add_argument("id", help="ledger id, e.g. A-0003")
    p_ar.add_argument("--status", required=True, help="confirmed | fix-needed | promoted")
    p_ar.add_argument("--notes", required=True, help="the guidance itself")
    p_ar.add_argument("--decision", help="decision slug (required with --status promoted)")
    p_ar.add_argument("--repo")
    p_ar.set_defaults(func=assumptions_mod.cmd_resolve)
    p_aa = as_sub.add_parser("archive",
                             help="compact resolved rows from finished tasks to assumptions-archive.md")
    p_aa.add_argument("--repo")
    p_aa.set_defaults(func=assumptions_mod.cmd_archive)

    p_note = sub.add_parser("note", help="jot a working note on the compaction scratchpad")
    p_note.add_argument("text", nargs="?", help="one line worth surviving a compaction")
    p_note.add_argument("--list", action="store_true", help="show current notes")
    p_note.add_argument("--repo")
    p_note.set_defaults(func=scratchpad_mod.cmd_note)

    p_def = sub.add_parser("defer", help="the deferral ledger (plans/deferrals.md)")
    def_sub = p_def.add_subparsers(dest="defer_command", required=True)
    p_da = def_sub.add_parser("add", help="ledger deliberately-removed scope with a revisit trigger")
    p_da.add_argument("item", help="what is being deferred, one sentence")
    p_da.add_argument("--why", required=True, help="why it is out of scope now")
    p_da.add_argument("--trigger", required=True, help="the condition that reopens it")
    p_da.add_argument("--repo")
    p_da.set_defaults(func=deferrals_mod.cmd_add)
    p_dls = def_sub.add_parser("list", help="show the ledger")
    p_dls.add_argument("--open", action="store_true")
    p_dls.add_argument("--repo")
    p_dls.set_defaults(func=deferrals_mod.cmd_list)
    p_dr = def_sub.add_parser("resolve", help="close a deferral (trigger fired or scope killed)")
    p_dr.add_argument("id", help="e.g. D-0001")
    p_dr.add_argument("--notes", required=True)
    p_dr.add_argument("--repo")
    p_dr.set_defaults(func=deferrals_mod.cmd_resolve)

    p_st = sub.add_parser("stage", help="per-task execution tracker (.factory/stages.json)")
    st_sub = p_st.add_subparsers(dest="stage_command", required=True)
    p_ss = st_sub.add_parser("start", help="begin a stage (order-enforced)")
    p_ss.add_argument("id", help="stage id from the recorded decomposition")
    p_ss.add_argument("--parallel", action="store_true",
                      help="skip order enforcement — ONLY for disjoint write scopes")
    p_ss.add_argument("--repo")
    p_ss.set_defaults(func=stages_mod.cmd_start)
    p_sd = st_sub.add_parser("done", help="finish a stage AFTER local autoreview + commit")
    p_sd.add_argument("id")
    p_sd.add_argument("--repo")
    p_sd.set_defaults(func=stages_mod.cmd_done)
    p_sls = st_sub.add_parser("list", help="show stage progress")
    p_sls.add_argument("--repo")
    p_sls.set_defaults(func=stages_mod.cmd_list)

    p_les = sub.add_parser("lesson", help="the durable lessons ledger (plans/lessons.jsonl)")
    les_sub = p_les.add_subparsers(dest="lesson_command", required=True)
    p_la = les_sub.add_parser("add", help="ledger a lesson after a repeated failure/review finding")
    p_la.add_argument("--topic", required=True)
    p_la.add_argument("--lesson", required=True, help="the lesson itself, one or two sentences")
    p_la.add_argument("--source", required=True, help="commit sha / review file / signal id")
    p_la.add_argument("--applies-to", nargs="+", required=True, dest="applies_to",
                      help="path globs, e.g. src/api/** *.sql")
    p_la.add_argument("--severity", required=True, help="low | medium | high")
    p_la.add_argument("--by", required=True, help="recording agent (schema allowlist)")
    p_la.add_argument("--repo")
    p_la.set_defaults(func=lessons_mod.cmd_add)
    p_lr = les_sub.add_parser("relevant", help="lessons matching the files you are about to touch")
    p_lr.add_argument("--files", nargs="*", help="paths (default: working-tree changes)")
    p_lr.add_argument("--repo")
    p_lr.set_defaults(func=lessons_mod.cmd_relevant)
    p_ll = les_sub.add_parser("list", help="show the whole ledger")
    p_ll.add_argument("--repo")
    p_ll.set_defaults(func=lessons_mod.cmd_list)

    p_aud = sub.add_parser("audit",
                           help="loop-health: audit the improvement loops themselves (advisory)")
    p_aud.add_argument("--repo")
    p_aud.set_defaults(func=audit_mod.cmd_audit)

    p_find = sub.add_parser("findings", help="review-finding pattern detection across tasks")
    find_sub = p_find.add_subparsers(dest="findings_command", required=True)
    p_fp = find_sub.add_parser("patterns",
                               help="cluster recorded findings by class; recurring = refactor signal")
    p_fp.add_argument("--repo")
    p_fp.set_defaults(func=findings_mod.cmd_patterns)

    p_sig = sub.add_parser("signal", help="worker→orchestrator event channel (.factory/signals.jsonl)")
    sig_sub = p_sig.add_subparsers(dest="signal_command", required=True)
    p_sr = sig_sub.add_parser("raise", help="worker: raise a contradiction/confusion/blocked/scope-change event, then PAUSE")
    p_sr.add_argument("--kind", required=True, help="contradiction | confusion | blocked | scope-change")
    p_sr.add_argument("--by", required=True, help="raising agent (schema allowlist)")
    p_sr.add_argument("-m", "--message", required=True, help="one sentence: what contradicts / what is unclear")
    p_sr.add_argument("--refs", nargs="*", help="files/records involved")
    p_sr.add_argument("--repo")
    p_sr.set_defaults(func=signal_mod.cmd_raise)
    p_sl = sig_sub.add_parser("list", help="show signals")
    p_sl.add_argument("--open", action="store_true")
    p_sl.add_argument("--repo")
    p_sl.set_defaults(func=signal_mod.cmd_list)
    p_sv = sig_sub.add_parser("resolve", help="orchestrator: answer an open signal")
    p_sv.add_argument("id", help="e.g. S-0001")
    p_sv.add_argument("--notes", required=True, help="the resolution the worker resumes with")
    p_sv.add_argument("--repo")
    p_sv.set_defaults(func=signal_mod.cmd_resolve)

    p_gs = sub.add_parser("gstack", help="project-local gstack store operations")
    gs_sub = p_gs.add_subparsers(dest="gstack_command", required=True)
    p_gm = gs_sub.add_parser(
        "migrate", help="one-time: merge a dev's personal ~/.gstack project store into the repo")
    p_gm.add_argument("--slug", help="gstack project slug (default: derived from origin/dirname)")
    p_gm.add_argument("--source", help="personal gstack home (default: ~/.gstack)")
    p_gm.add_argument("--repo")
    p_gm.set_defaults(func=gstack_mod.cmd_migrate)

    p_dec = sub.add_parser("decision", help="manage decision records")
    dec_sub = p_dec.add_subparsers(dest="decision_command", required=True)
    p_new = dec_sub.add_parser("new", help="create the next NNNN-<slug>.md record")
    p_new.add_argument("slug")
    p_new.add_argument("--title")
    p_new.add_argument("--supersedes",
                       help="slug of the decision this replaces (old record is marked superseded)")
    p_new.add_argument("--repo", help="target repo (defaults to this repo)")
    p_new.set_defaults(func=decisions.cmd_new)
    p_dl = dec_sub.add_parser("list", help="show decision records (--active: the live corpus)")
    p_dl.add_argument("--active", action="store_true")
    p_dl.add_argument("--repo")
    p_dl.set_defaults(func=decisions.cmd_list)
    p_acc = dec_sub.add_parser("accept", help="mark a decision accepted with a human's name")
    p_acc.add_argument("slug")
    p_acc.add_argument("--by", required=True, help="the human confirming (not an agent)")
    p_acc.add_argument("--repo")
    p_acc.set_defaults(func=decisions.cmd_accept)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
