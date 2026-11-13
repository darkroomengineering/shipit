"""Point ubuntu jobs at the studio Mac through vars.CI_RUNNER, keeping the hosted
label as the fallback. Jobs that need Linux or Docker are left alone.

usage: python3 -I runner/convert-workflows.py [--write] FILE...
Prints one line per job: CONVERT / KEEP(reason) / SKIP(non-ubuntu).
"""
import re
import sys

BLOCKERS = [
    (r"^\s+services:", "services"),
    (r"^\s+container:", "container"),
    (r"apt-get|apt install", "apt"),
    (r"\bdocker\b", "docker"),
    (r"appleboy/", "docker action"),
    (r"brakeman-linter-action", "docker action"),
    (r"tailscale/github-action", "tailscale"),
    (r"sed -i", "GNU sed"),
    (r"sha256sum|md5sum", "GNU coreutils"),
    (r"\bnproc\b", "GNU coreutils"),
    (r"readlink -f", "GNU coreutils"),
    (r"playwright", "playwright snapshots are per-OS"),
    (r"/home/runner", "linux path"),
]
RUNS_ON = re.compile(r"^(\s+runs-on:\s*)(ubuntu-[\w.]+)\s*$")
JOB = re.compile(r"^  [A-Za-z0-9_-]+:\s*$")


def convert(path, write):
    lines = open(path).read().split("\n")
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith("jobs:"))
    except StopIteration:
        return []
    heads = [i for i in range(start + 1, len(lines)) if JOB.match(lines[i])]
    ends = heads[1:] + [next((i for i in range(start + 1, len(lines)) if lines[i] and not lines[i][0].isspace() and not lines[i].startswith("#")), len(lines))]
    out = []
    changed = False
    for h, e in zip(heads, ends):
        block = lines[h:e]
        name = lines[h].strip().rstrip(":")
        ro = [(h + k, m) for k, l in enumerate(block) if (m := RUNS_ON.match(l))]
        if not ro:
            out.append(f"SKIP {name}")
            continue
        text = "\n".join(block)
        reasons = sorted({r for pat, r in BLOCKERS if re.search(pat, text, re.M)})
        if reasons:
            out.append(f"KEEP {name} ({', '.join(reasons)})")
            continue
        for idx, m in ro:
            lines[idx] = f"{m.group(1)}${{{{ fromJSON(vars.CI_RUNNER || '\"{m.group(2)}\"') }}}}"
        changed = True
        out.append(f"CONVERT {name}")
    if write and changed:
        open(path, "w").write("\n".join(lines))
    return out


if __name__ == "__main__":
    write = "--write" in sys.argv
    for p in [a for a in sys.argv[1:] if a != "--write"]:
        for r in convert(p, write):
            print(f"{p}\t{r}")
