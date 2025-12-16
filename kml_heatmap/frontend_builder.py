"""Frontend build utilities for TypeScript compilation."""

import subprocess
from pathlib import Path

from .logger import logger


def get_frontend_dir() -> Path:
    """Get the path to the frontend directory.

    Returns:
        Path to kml_heatmap/frontend/
    """
    return Path(__file__).parent / "frontend"


def get_static_dir() -> Path:
    """Get the path to the static output directory.

    Returns:
        Path to kml_heatmap/static/
    """
    return Path(__file__).parent / "static"


def check_node_installed() -> bool:
    """Check if Node.js and npm are installed.

    Returns:
        True if both are available, False otherwise
    """
    try:
        subprocess.run(
            ["node", "--version"],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["npm", "--version"],
            check=True,
            capture_output=True,
            text=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def install_frontend_dependencies() -> bool:
    """Install npm dependencies for the frontend.

    Returns:
        True if successful, False otherwise
    """
    frontend_dir = get_frontend_dir()

    if not frontend_dir.exists():
        logger.error(f"Frontend directory not found: {frontend_dir}")
        return False

    logger.info("Installing frontend dependencies...")

    try:
        subprocess.run(
            ["npm", "install"],
            cwd=frontend_dir,
            check=True,
            capture_output=True,
            text=True,
        )
        logger.info("Frontend dependencies installed successfully")
        return True
    except subprocess.CalledProcessError as e:
        logger.error(f"Failed to install frontend dependencies: {e.stderr}")
        return False


def build_frontend(force: bool = False) -> bool:
    """Build the TypeScript frontend.

    Args:
        force: If True, always rebuild even if output exists

    Returns:
        True if successful, False otherwise
    """
    frontend_dir = get_frontend_dir()
    static_dir = get_static_dir()
    output_file = static_dir / "map.js"

    # Check if build is needed
    if not force and output_file.exists():
        # Check if source files are newer than output
        src_dir = frontend_dir / "src"
        if src_dir.exists():
            src_mtime = max(
                f.stat().st_mtime
                for f in src_dir.rglob("*.ts")
                if not f.name.endswith(".test.ts")
            )
            output_mtime = output_file.stat().st_mtime

            if src_mtime <= output_mtime:
                logger.debug("Frontend build is up to date, skipping")
                return True

    if not check_node_installed():
        logger.error(
            "Node.js and npm are required to build the frontend. "
            "Please install Node.js from https://nodejs.org/"
        )
        return False

    # Ensure dependencies are installed
    node_modules = frontend_dir / "node_modules"
    if not node_modules.exists():
        if not install_frontend_dependencies():
            return False

    logger.info("Building frontend TypeScript...")

    try:
        result = subprocess.run(
            ["npm", "run", "build"],
            cwd=frontend_dir,
            check=True,
            capture_output=True,
            text=True,
        )

        if result.stdout:
            logger.debug(f"Build output: {result.stdout}")

        logger.info(f"Frontend built successfully → {output_file}")
        return True

    except subprocess.CalledProcessError as e:
        logger.error("Frontend build failed:")
        if e.stdout:
            logger.error(f"STDOUT: {e.stdout}")
        if e.stderr:
            logger.error(f"STDERR: {e.stderr}")
        return False


def run_frontend_tests() -> bool:
    """Run frontend TypeScript tests.

    Returns:
        True if all tests pass, False otherwise
    """
    frontend_dir = get_frontend_dir()

    if not check_node_installed():
        logger.error("Node.js and npm are required to run frontend tests")
        return False

    # Ensure dependencies are installed
    node_modules = frontend_dir / "node_modules"
    if not node_modules.exists():
        if not install_frontend_dependencies():
            return False

    logger.info("Running frontend tests...")

    try:
        result = subprocess.run(
            ["npm", "test"],
            cwd=frontend_dir,
            check=True,
            capture_output=True,
            text=True,
        )

        if result.stdout:
            logger.info(f"Test output:\n{result.stdout}")

        logger.info("All frontend tests passed")
        return True

    except subprocess.CalledProcessError as e:
        logger.error(f"Frontend tests failed:\n{e.stdout}\n{e.stderr}")
        return False


def ensure_frontend_built() -> None:
    """Ensure frontend is built, building if necessary.

    Raises:
        RuntimeError: If frontend build fails
    """
    if not build_frontend():
        raise RuntimeError(
            "Failed to build frontend. Ensure Node.js is installed and "
            "run 'npm install' in kml_heatmap/frontend/"
        )
