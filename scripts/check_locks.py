#!/usr/bin/env python3
"""Check that the hashed lock files still satisfy pyproject.toml, that the
Playwright image is pinned by digest and matches the pinned library (in the
workflow and in the commands the documentation quotes), and that the package
version is the same on both sides of the project.

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
# The Playwright image of the test workflow, as a tag and a digest
# (v1.2.3-noble@sha256:...). The groups are the whole reference, the version
# and the digest; the digest is optional here so that a missing one is
# reported as such rather than as a workflow without the image.
PLAYWRIGHT_IMAGE = re.compile(
    r"image:\s*(mcr\.microsoft\.com/playwright:v(\S+?)-[a-z]+"
    r"(?:@(sha256:[0-9a-f]{64}))?)\s*$",
    re.MULTILINE,
)
# Any reference to the Playwright image, such as in a documented command
PLAYWRIGHT_IMAGE_REFERENCE = re.compile(r"mcr\.microsoft\.com/playwright:[^\s`]+")
# The documents that quote the image for running the visual tests locally
PLAYWRIGHT_IMAGE_DOCS = ("CONTRIBUTING.md", "DEVELOPMENT.md")


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
    image, version, digest = match.groups()
    problems = []
    # A tag alone can be moved to another build; the digest cannot
    if digest is None:
        problems.append(
            ".github/workflows/test.yml does not pin the Playwright image "
            "by its @sha256 digest"
        )
    pinned = read_npm_version("@playwright/test")
    if pinned is None:
        problems.append("package-lock.json does not pin @playwright/test")
    elif version != pinned:
        problems.append(
            f".github/workflows/test.yml runs the Playwright image "
            f"v{version}, package-lock.json pins {pinned}"
        )
    # The documented commands are how the snapshots get regenerated, so an
    # image other than the one CI compares in produces snapshots that fail
    for name in PLAYWRIGHT_IMAGE_DOCS:
        path = ROOT / name
        if not path.is_file():
            continue
        problems.extend(
            f"{name} quotes the Playwright image {quoted}, "
            f".github/workflows/test.yml runs {image}"
            for quoted in PLAYWRIGHT_IMAGE_REFERENCE.findall(
                path.read_text(encoding="utf-8")
            )
            if quoted != image
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
        pyproject = tomllib.load(f)
    project = pyproject["project"]
    # What building the wheel needs; CI installs it from its own lock file to
    # build without isolation (see `make lock`)
    build: list[str] = pyproject.get("build-system", {}).get("requires", [])
    runtime: list[str] = project["dependencies"]
    extras: dict[str, list[str]] = project["optional-dependencies"]
    tooling = extras["test"] + extras["dev"]

    runtime_pins = read_pins("requirements.lock")
    test_pins = read_pins("requirements-test.lock")

    problems = unsatisfied(runtime, runtime_pins, "requirements.lock")
    problems += unsatisfied(runtime + tooling, test_pins, "requirements-test.lock")
    if build and not (ROOT / "requirements-build.lock").is_file():
        problems.append("requirements-build.lock is missing")
    elif build:
        problems += unsatisfied(
            build, read_pins("requirements-build.lock"), "requirements-build.lock"
        )
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
            "requirements.lock, requirements-test.lock and "
            "requirements-build.lock.",
            file=sys.stderr,
        )
    if image_problems:
        print(
            "The Playwright image in .github/workflows/test.yml (tag and "
            "digest), the image CONTRIBUTING.md and DEVELOPMENT.md quote and "
            "the @playwright/test version in package-lock.json have to agree.",
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
