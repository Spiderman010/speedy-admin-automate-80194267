#!/usr/bin/env python3
"""PreToolUse hook: block any `git push` whose destination is main.

main only advances via merged pull requests (AGENTS.md). Permission-rule
prefix matching cannot reliably recognise every push spelling (refspecs,
force flags, alternative remote names), so this hook inspects the actual
Bash command. It reads only stdin and .git/HEAD — no network access, no
database logic, no subprocesses.

Exit codes: 0 = allow, 2 = block (message on stderr is shown to Claude).
"""
import json
import os
import re
import shlex
import sys

# git push flags that consume a following value token.
PUSH_FLAGS_WITH_VALUE = {"--receive-pack", "--exec", "-o", "--push-option"}
# git push modes that push every branch, which necessarily includes main.
PUSH_ALL_BRANCH_FLAGS = {"--all", "--branches", "--mirror"}
# git global options (between `git` and the subcommand) that consume a value.
GIT_GLOBAL_FLAGS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}


def current_branch():
    """Resolve the checked-out branch by reading .git/HEAD (worktree-aware)."""
    path = ".git"
    try:
        if os.path.isfile(path):
            with open(path) as f:
                m = re.match(r"gitdir:\s*(.+)", f.read().strip())
            if not m:
                return None
            path = m.group(1)
        with open(os.path.join(path, "HEAD")) as f:
            m = re.match(r"ref:\s*refs/heads/(.+)", f.read().strip())
        return m.group(1) if m else None
    except OSError:
        return None


def refspec_destination(refspec):
    """Destination branch of a push refspec (handles +, src:dst, refs/heads/).

    HEAD and @ resolve to the checked-out branch, exactly as git resolves them.
    """
    spec = refspec.lstrip("+")
    dest = spec.rsplit(":", 1)[1] if ":" in spec else spec
    if dest.startswith("refs/heads/"):
        dest = dest[len("refs/heads/"):]
    if dest in ("HEAD", "@"):
        return current_branch()
    return dest or None


def push_targets_main(args):
    """True when the tokens after `push` can update main (any remote name)."""
    refspecs = []
    positional = 0
    has_repo_flag = False
    i = 0
    while i < len(args):
        t = args[i]
        if t == "--":
            i += 1
            continue
        if t in PUSH_ALL_BRANCH_FLAGS:
            # --all / --branches / --mirror push every branch, including main.
            return True
        if t == "--repo" or t.startswith("--repo="):
            # --repo supplies the repository, so every positional that follows
            # can be a refspec rather than the remote name.
            has_repo_flag = True
            i += 2 if t == "--repo" else 1
            continue
        if t.startswith("-"):
            i += 2 if t in PUSH_FLAGS_WITH_VALUE else 1
            continue
        positional += 1
        if has_repo_flag or positional >= 2:
            refspecs.append(t)  # without --repo, the first positional is the remote
        i += 1
    if not refspecs:
        # Bare `git push` (or remote only): destination is the current branch.
        return current_branch() == "main"
    for spec in refspecs:
        if spec.lstrip("+") == ":":
            # Matching refspec (":" / "+:") pushes all matching branches and
            # can therefore update main.
            return True
        if refspec_destination(spec) == "main":
            return True
    return False


def command_pushes_main(command):
    """Scan every simple command in a compound shell line for a main push."""
    for segment in re.split(r"(?:&&|\|\||;|\||\n)", command):
        try:
            tokens = shlex.split(segment)
        except ValueError:
            tokens = segment.split()  # unparseable quoting: inspect crudely
        if "git" not in tokens:
            continue
        rest = tokens[tokens.index("git") + 1:]
        j = 0
        while j < len(rest):
            t = rest[j]
            if t in GIT_GLOBAL_FLAGS_WITH_VALUE:
                j += 2
            elif t.startswith("-"):
                j += 1
            else:
                break
        if j < len(rest) and rest[j] == "push" and push_targets_main(rest[j + 1:]):
            return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if data.get("tool_name") not in (None, "Bash"):
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    if command_pushes_main(command):
        sys.stderr.write(
            "BLOCKED: pushing to 'main' is not allowed in this repository — "
            "main only advances via merged pull requests. Push to a feature/* "
            "or fix/* branch instead (see AGENTS.md).\n"
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
