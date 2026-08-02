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
PUSH_FLAGS_WITH_VALUE = {"--repo", "--receive-pack", "--exec", "-o", "--push-option"}
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
    """Destination branch of a push refspec (handles +, src:dst, refs/heads/)."""
    spec = refspec.lstrip("+")
    dest = spec.rsplit(":", 1)[1] if ":" in spec else spec
    if dest.startswith("refs/heads/"):
        dest = dest[len("refs/heads/"):]
    return dest or None


def push_targets_main(args):
    """True when the tokens after `push` target main (any remote name)."""
    refspecs = []
    positional = 0
    i = 0
    while i < len(args):
        t = args[i]
        if t == "--":
            i += 1
            continue
        if t.startswith("-"):
            i += 2 if t in PUSH_FLAGS_WITH_VALUE else 1
            continue
        positional += 1
        if positional >= 2:  # first positional is the remote, rest are refspecs
            refspecs.append(t)
        i += 1
    if not refspecs:
        # Bare `git push` (or remote only): destination is the current branch.
        return current_branch() == "main"
    return any(refspec_destination(spec) == "main" for spec in refspecs)


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
