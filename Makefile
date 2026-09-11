.PHONY: all build serve serve-build test lint format lock clean help
.PHONY: check-obfuscation require-runtime

# API keys are read from the environment (or the make command line) and passed
# into the build container by name only, so their values never show up in the
# make output or the process list.
CARTO_API_KEY ?=
OPENAIP_API_KEY ?=
export CARTO_API_KEY OPENAIP_API_KEY

# Container runtime: podman is preferred, docker is the fallback.
CONTAINER_RUNTIME ?= $(shell command -v podman 2>/dev/null || command -v docker 2>/dev/null)
INPUT_DIR ?= data
OUTPUT_DIR ?= docs
CACHE_DIR ?= $(HOME)/.cache/kml-heatmap
HOST_BIND ?= 127.0.0.1
PORT ?= 8000
IMAGE_NAME := kml-heatmap

# INPUT_DIR and OUTPUT_DIR are mounted below /data using their base names, so
# the defaults map to /data/data and /data/docs inside the container.
ifneq ($(words $(INPUT_DIR)),1)
$(error INPUT_DIR must not contain spaces)
endif
ifneq ($(words $(OUTPUT_DIR)),1)
$(error OUTPUT_DIR must not contain spaces)
endif

INPUT_MOUNT := /data/$(notdir $(abspath $(INPUT_DIR)))
OUTPUT_MOUNT := /data/$(notdir $(abspath $(OUTPUT_DIR)))

# Runtime specific flags. They are expanded lazily (recursive variables) so that
# targets without a container runtime keep working. Rootless podman maps the
# host user into the container with keep-id, but keeps the image's USER unless
# --user is given; docker needs --user so that files written to bind mounts are
# not owned by root. HOME is set because the mapped uid has no passwd entry.
IS_PODMAN := $(shell $(CONTAINER_RUNTIME) --version 2>/dev/null | grep -qi podman && echo yes)
ifeq ($(IS_PODMAN),yes)
RUN_AS_USER = --userns=keep-id --user "$(shell id -u):$(shell id -g)" --security-opt label=disable
else
RUN_AS_USER = --user "$(shell id -u):$(shell id -g)"
endif
TTY_FLAG = $(if $(shell test -t 0 && echo y),-it,-i)

all: build

help: ## Show available targets and variables
	@echo "Targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-24s %s\n", $$1, $$2}'
	@echo
	@echo "Variables (current values):"
	@echo "  CONTAINER_RUNTIME=$(CONTAINER_RUNTIME)"
	@echo "  INPUT_DIR=$(INPUT_DIR)"
	@echo "  OUTPUT_DIR=$(OUTPUT_DIR)"
	@echo "  CACHE_DIR=$(CACHE_DIR)"
	@echo "  HOST_BIND=$(HOST_BIND)"
	@echo "  PORT=$(PORT)"
	@echo "  CARTO_API_KEY, OPENAIP_API_KEY (values are not printed)"

require-runtime:
	@test -n "$(CONTAINER_RUNTIME)" || { \
	  echo "error: no container runtime found; install podman or docker, or set CONTAINER_RUNTIME"; \
	  exit 1; }

build: require-runtime ## Build the image and generate OUTPUT_DIR from INPUT_DIR (obfuscates the input KML files in place)
	@test -d "$(INPUT_DIR)" || { \
	  echo "error: input directory '$(INPUT_DIR)' not found; put your KML files there or run 'make build INPUT_DIR=path'"; \
	  exit 1; }
	@test "$(INPUT_MOUNT)" != "$(OUTPUT_MOUNT)" || { \
	  echo "error: INPUT_DIR and OUTPUT_DIR must have different base names"; \
	  exit 1; }
	$(CONTAINER_RUNTIME) build -t $(IMAGE_NAME) .
	mkdir -p "$(CACHE_DIR)" "$(OUTPUT_DIR)"
	$(CONTAINER_RUNTIME) run --rm $(RUN_AS_USER) -e HOME=/tmp \
	  -e CARTO_API_KEY -e OPENAIP_API_KEY \
	  -v "$(abspath $(INPUT_DIR)):$(INPUT_MOUNT)" \
	  -v "$(abspath $(OUTPUT_DIR)):$(OUTPUT_MOUNT)" \
	  -v "$(CACHE_DIR):/cache" \
	  $(IMAGE_NAME) "$(INPUT_MOUNT)" --output-dir "$(OUTPUT_MOUNT)"

serve: require-runtime ## Serve OUTPUT_DIR on http://HOST_BIND:PORT (run 'make build' first)
	@test -f "$(OUTPUT_DIR)/index.html" || { \
	  echo "error: '$(OUTPUT_DIR)/index.html' not found; run 'make build' first"; \
	  exit 1; }
	$(CONTAINER_RUNTIME) run --rm $(TTY_FLAG) $(RUN_AS_USER) -e HOME=/tmp \
	  -p "$(HOST_BIND):$(PORT):8000" -e BIND_HOST=0.0.0.0 \
	  -v "$(abspath $(OUTPUT_DIR)):/data:ro" \
	  --entrypoint python $(IMAGE_NAME) /app/serve.py

serve-build: build ## Run build, then serve
	$(MAKE) serve

check-obfuscation: ## Check that the KML files in INPUT_DIR are obfuscated
	python -m kml_heatmap.obfuscate "$(INPUT_DIR)" --check

lint: ## Run linters and type checkers
	ruff check .
	mypy .
	bandit -r kml_heatmap -ll
	npm run typecheck
	npm run typecheck:tests
	npm run lint

format: ## Run formatters
	ruff format .
	npm run format

test: ## Run the JavaScript and Python test suites with coverage
	npm run test:coverage
	pytest -n auto --cov=kml_heatmap --cov-branch --cov-report=xml --cov-report=term
	coverage report

# The dependencies are declared once, in pyproject.toml: the runtime
# dependencies become requirements.lock, the test and dev extras
# requirements-test.lock. pip-tools is installed into a throwaway environment
# rather than added to the extras, so it cannot drift into what the lock
# files pin.
lock: ## Regenerate requirements.lock and requirements-test.lock from pyproject.toml with pip-compile
	@tmp=$$(mktemp -d) && \
	  python -m venv "$$tmp" && \
	  "$$tmp/bin/pip" install --quiet --disable-pip-version-check pip-tools && \
	  CUSTOM_COMPILE_COMMAND="make lock" "$$tmp/bin/pip-compile" --quiet \
	    --generate-hashes --strip-extras --upgrade \
	    --output-file=requirements.lock pyproject.toml && \
	  CUSTOM_COMPILE_COMMAND="make lock" "$$tmp/bin/pip-compile" --quiet \
	    --generate-hashes --strip-extras --upgrade --extra test --extra dev \
	    --output-file=requirements-test.lock pyproject.toml; \
	  status=$$?; rm -rf "$$tmp"; exit $$status

clean: ## Remove the container image (when a runtime is available) and local build artifacts
	-@test -z "$(CONTAINER_RUNTIME)" || $(CONTAINER_RUNTIME) rmi $(IMAGE_NAME) 2>/dev/null
	rm -rf htmlcov coverage coverage.xml .coverage .coverage.* test-results playwright-report \
	  dist build *.egg-info .mypy_cache .ruff_cache .pytest_cache .hypothesis \
	  kml_heatmap/static/mapApp.bundle.js kml_heatmap/static/mapApp.bundle.js.map
