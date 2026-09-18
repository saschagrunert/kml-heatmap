#!/usr/bin/env python3
"""Check that the hashed lock files still satisfy pyproject.toml, that the
Playwright image matches the pinned library, and that the package version is
the same on both sides of the project.

Dependabot raises the ranges in pyproject.toml but cannot recompile the
lock files, and CI installs the lock files. Without this check such a pull
request passes CI while testing the old versions. The version in
kml_heatmap/__init__.py is what `--version` and the wheel report, and
package.json and package-lock.json carry it again for the npm side; nothing
reads all of them, so they drift apart unnoticed until a release says two
different things. The pre-commit hooks are not checked here: the linters and
formatters run from the project environment, so they have no revision of
their own to drift. Run by `make lint` and the CI lint job.
"""

import functools
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import Any

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)", re.MULTILINE)
# The __version__ assignment at the top of kml_heatmap/__init__.py
PACKAGE_VERSION = re.compile(r'^__version__\s*=\s*"([^"]+)"', re.MULTILINE)
# "image: mcr.microsoft.com/playwright:v1.2.3-noble" in the test workflow
PLAYWRIGHT_IMAGE = re.compile(
    r"image:\s*mcr\.microsoft\.com/playwright:v(\S+?)-[a-z]+\s*$", re.MULTILINE
)


@functools.cache
def read_package_lock() -> dict[str, Any]:
    """package-lock.json, parsed once. Two checks below read it, and it is
    the largest file this script opens. Callers only read the result."""
    with open(ROOT / "package-lock.json", encoding="utf-8") as f:
        lock: dict[str, Any] = json.load(f)
    return lock


def read_npm_version(name: str) -> str | None:
    """The version of a package pinned in package-lock.json."""
    packages = read_package_lock()["packages"]
    version = packages.get(f"node_modules/{name}", {}).get("version")
    return str(version) if version else None


def read_python_version() -> str | None:
    """The version kml_heatmap/__init__.py declares."""
    text = (ROOT / "kml_heatmap/__init__.py").read_text(encoding="utf-8")
    match = PACKAGE_VERSION.search(text)
    return match.group(1) if match else None


def npm_versions() -> dict[str, str | None]:
    """The package version the npm files declare, by where it is written.

    package-lock.json carries it twice, at the top level and in the entry of
    the root package. npm writes both, so a bump by hand that only edits
    package.json leaves them behind until the next install rewrites the lock,
    where the change then turns up as noise in an unrelated pull request.
    """
    with open(ROOT / "package.json", encoding="utf-8") as f:
        package = json.load(f)
    lock = read_package_lock()
    root_entry = lock.get("packages", {}).get("", {})
    return {
        "package.json": package.get("version"),
        'package-lock.json "version"': lock.get("version"),
        'package-lock.json packages[""]': root_entry.get("version"),
    }


def version_mismatches() -> list[str]:
    """Describe every place the package version differs from __init__.py.

    kml_heatmap/__init__.py is the one pyproject.toml reads (its version is
    dynamic), so it is what the others have to agree with.
    """
    expected = read_python_version()
    if expected is None:
        return ["kml_heatmap/__init__.py declares no __version__"]

    problems = []
    for source, version in npm_versions().items():
        if version is None:
            problems.append(f"{source} declares no version")
        elif version != expected:
            problems.append(
                f"kml_heatmap/__init__.py is {expected}, {source} {version}"
            )
    return problems


def playwright_image_mismatches() -> list[str]:
    """Check the Playwright container against the pinned @playwright/test.

    The visual job compares screenshots inside that image, and the committed
    snapshots were generated in it. An image a version ahead of the library
    renders differently, which reads as a page regression rather than as the
    version drift it is.
    """
    text = (ROOT / ".github/workflows/test.yml").read_text(encoding="utf-8")
    match = PLAYWRIGHT_IMAGE.search(text)
    if match is None:
        return [".github/workflows/test.yml runs no Playwright image"]
    pinned = read_npm_version("@playwright/test")
    if pinned is None:
        return ["package-lock.json does not pin @playwright/test"]
    if match.group(1) != pinned:
        return [
            (
                f".github/workflows/test.yml runs the Playwright image "
                f"v{match.group(1)}, package-lock.json pins {pinned}"
            )
        ]
    return []


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

    image_problems = playwright_image_mismatches()
    version_problems = version_mismatches()

    if not problems and not image_problems and not version_problems:
        print(
            "The lock files satisfy pyproject.toml, the Playwright image "
            "matches and the package version agrees."
        )
        return 0
    for problem in problems + image_problems + version_problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        print(
            "The lock files are out of date; run `make lock` and commit "
            "requirements.lock and requirements-test.lock.",
            file=sys.stderr,
        )
    if image_problems:
        print(
            "Set the Playwright image in .github/workflows/test.yml to the "
            "version package-lock.json pins.",
            file=sys.stderr,
        )
    if version_problems:
        print(
            "Set the same version in kml_heatmap/__init__.py and package.json, "
            "then run `npm install` to carry it into package-lock.json.",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
