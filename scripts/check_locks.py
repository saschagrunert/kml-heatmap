#!/usr/bin/env python3
"""Check that the hashed lock files still satisfy pyproject.toml.

Dependabot raises the ranges in pyproject.toml but cannot recompile the
lock files, and CI installs the lock files. Without this check such a pull
request passes CI while testing the old versions. Run by `make lint` and
the CI lint job.
"""

import re
import sys
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)", re.MULTILINE)


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

    if not problems:
        print("The lock files satisfy pyproject.toml.")
        return 0
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    print(
        "The lock files are out of date; run `make lock` and commit "
        "requirements.lock and requirements-test.lock.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
