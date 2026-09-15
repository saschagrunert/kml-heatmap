#!/usr/bin/env python3
"""Check that the hashed lock files still satisfy pyproject.toml, and that the
pre-commit hooks run the tool versions the lock files and CI pin.

Dependabot raises the ranges in pyproject.toml but cannot recompile the
lock files, and CI installs the lock files. Without this check such a pull
request passes CI while testing the old versions. The ruff, prettier and
typos hooks in .pre-commit-config.yaml mirror requirements-test.lock,
package-lock.json and the typos action in the test workflow; a hook that
drifts ahead rewrites files CI then rejects, or the other way round. Run by
`make lint` and the CI lint job.
"""

import json
import re
import sys
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)", re.MULTILINE)
# "- repo: <url>" followed (after any comments) by "rev: <tag>"
HOOK_REV = re.compile(
    r"^\s*-\s*repo:\s*(\S+)\n(?:\s*#[^\n]*\n)*\s*rev:\s*v?(\S+)", re.MULTILINE
)
# "uses: crate-ci/typos@<sha> # v1.2.3": the version is the comment
TYPOS_ACTION = re.compile(r"uses:\s*crate-ci/typos@\S+\s*#\s*v?(\S+)")

HOOKS = {
    "https://github.com/astral-sh/ruff-pre-commit": "ruff",
    "https://github.com/rbubley/mirrors-prettier": "prettier",
    "https://github.com/crate-ci/typos": "typos",
}


def read_hook_revs() -> dict[str, str]:
    """Map each mirrored tool to the version its pre-commit hook pins."""
    text = (ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8")
    return {HOOKS[repo]: rev for repo, rev in HOOK_REV.findall(text) if repo in HOOKS}


def read_npm_version(name: str) -> str | None:
    """The version of a package pinned in package-lock.json."""
    with open(ROOT / "package-lock.json", encoding="utf-8") as f:
        packages = json.load(f)["packages"]
    version = packages.get(f"node_modules/{name}", {}).get("version")
    return str(version) if version else None


def read_typos_action_version() -> str | None:
    """The typos version the CI workflow runs."""
    text = (ROOT / ".github/workflows/test.yml").read_text(encoding="utf-8")
    match = TYPOS_ACTION.search(text)
    return match.group(1) if match else None


def hook_mismatches(test_pins: dict[str, str]) -> list[str]:
    """Describe every pre-commit hook whose version differs from its source."""
    hooks = read_hook_revs()
    sources = {
        "ruff": ("requirements-test.lock", test_pins.get("ruff")),
        "prettier": ("package-lock.json", read_npm_version("prettier")),
        "typos": (".github/workflows/test.yml", read_typos_action_version()),
    }
    problems = []
    for tool, (source, version) in sources.items():
        hook = hooks.get(tool)
        if hook is None:
            problems.append(f".pre-commit-config.yaml has no {tool} hook")
        elif version is None:
            problems.append(f"{source} does not pin {tool}")
        elif hook != version:
            problems.append(
                f".pre-commit-config.yaml pins {tool} v{hook}, "
                f"{source} {tool} {version}"
            )
    return problems


def read_pins(lock: str) -> dict[str, str]:
    """Map each package pinned in a pip-compile output to its version."""
    text = (ROOT / lock).read_text(encoding="utf-8")
    return {canonicalize_name(name): version for name, version in PIN.findall(text)}


def unsatisfied(requirements: list[str], pins: dict[str, str], lock: str) -> list[str]:
    """Describe every requirement the pins of a lock file do not meet."""
    problems = []
    for line in requirements:
        requirement = Requirement(line)
        if requirement.marker is not None and not requirement.marker.evaluate():
            continue
        pinned = pins.get(canonicalize_name(requirement.name))
        if pinned is None:
            problems.append(f"{lock} does not pin {requirement.name}")
        elif not requirement.specifier.contains(pinned, prereleases=True):
            problems.append(
                f"{lock} pins {requirement.name}=={pinned}, "
                f'pyproject.toml asks for "{line}"'
            )
    return problems


def main() -> int:
    """Print the mismatches and return the exit status."""
    with open(ROOT / "pyproject.toml", "rb") as f:
        project = tomllib.load(f)["project"]
    runtime: list[str] = project["dependencies"]
    extras: dict[str, list[str]] = project["optional-dependencies"]
    tooling = extras["test"] + extras["dev"]

    runtime_pins = read_pins("requirements.lock")
    test_pins = read_pins("requirements-test.lock")

    problems = unsatisfied(runtime, runtime_pins, "requirements.lock")
    problems += unsatisfied(runtime + tooling, test_pins, "requirements-test.lock")
    # CI installs requirements-test.lock alone where it needs both, which is
    # only the same as installing both while the shared pins agree
    problems += [
        f"requirements.lock pins {name}=={version}, "
        f"requirements-test.lock {name}=={test_pins.get(name)}"
        for name, version in runtime_pins.items()
        if test_pins.get(name) != version
    ]

    hook_problems = hook_mismatches(test_pins)

    if not problems and not hook_problems:
        print("The lock files satisfy pyproject.toml and the hooks match them.")
        return 0
    for problem in problems + hook_problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        print(
            "The lock files are out of date; run `make lock` and commit "
            "requirements.lock and requirements-test.lock.",
            file=sys.stderr,
        )
    if hook_problems:
        print(
            "Set the rev of each hook in .pre-commit-config.yaml to the version "
            "its source pins.",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
