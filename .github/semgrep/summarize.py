"""Summarize a Semgrep JSON report for the "Static analysis" job summary (#473).

Usage: summarize.py pr|full <report.json>

Prints Markdown and exits 0 for a valid report. Exits 1, printing nothing, when the
report is missing, is not JSON, or lacks the results and errors lists: the scanner
failed, and that must not read as a clean run. scripts/ci/semgrep-summary.test.mjs
pins this. Standard library only: it runs on the job's venv Python.
"""

import json
import sys
from collections import Counter


def main(argv):
    if len(argv) != 3 or argv[1] not in ("pr", "full"):
        print("usage: summarize.py pr|full <report.json>", file=sys.stderr)
        return 2
    mode, path = argv[1], argv[2]
    try:
        with open(path, encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, ValueError) as error:
        print(f"No valid Semgrep report at {path}: {error}", file=sys.stderr)
        return 1
    results = report.get("results") if isinstance(report, dict) else None
    errors = report.get("errors") if isinstance(report, dict) else None
    if not isinstance(results, list) or not isinstance(errors, list):
        print(f"The Semgrep report at {path} has no results and errors lists.", file=sys.stderr)
        return 1

    lines = []
    if mode == "pr":
        lines += ["### Semgrep: ERROR findings this pull request adds", "", f"New ERROR findings: {len(results)}", ""]
        for result in results:
            message = str(result.get("extra", {}).get("message", "")).split("\n")[0]
            line = result.get("start", {}).get("line")
            lines.append(f"- `{result.get('path')}:{line}` {result.get('check_id')}: {message}")
        if results:
            lines += ["", "Fix a finding, or suppress it on its line with `nosemgrep: <rule-id> -- <reason>`."]
    else:
        severities = Counter(str(result.get("extra", {}).get("severity", "UNKNOWN")) for result in results)
        lines += ["### Semgrep: full scan of develop", "", "| Severity | Findings |", "| --- | --- |"]
        lines += [f"| {severity} | {count} |" for severity, count in sorted(severities.items())]
        lines += ["", f"Scanner errors: {len(errors)}.", "", "The full JSON is the semgrep-develop artifact, kept for 90 days."]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
