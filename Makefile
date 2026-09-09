.PHONY: all build serve test-image test lint format clean help
.PHONY: lint-local format-local test-local verify
.PHONY: check-obfuscation

CARTO_API_KEY ?=
OPENAIP_API_KEY ?=
CONTAINER_RUNTIME ?= $(shell command -v podman 2>/dev/null || command -v docker 2>/dev/null)
INPUT_DIR ?= data

OUTPUT_DIR ?= docs
IMAGE_NAME := kml-heatmap
CACHE_DIR := $(HOME)/.cache/kml-heatmap

# Guard: ensure a container runtime is available
ifeq ($(CONTAINER_RUNTIME),)
$(error No container runtime found. Install podman or docker)
endif

all: build

help: ## Show available targets
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

build: ## Build and run the KML heatmap pipeline in Docker
	$(CONTAINER_RUNTIME) build -t $(IMAGE_NAME) .
	mkdir -p $(CACHE_DIR) $(OUTPUT_DIR)
	$(CONTAINER_RUNTIME) run -e CARTO_API_KEY=$(CARTO_API_KEY) -e OPENAIP_API_KEY=$(OPENAIP_API_KEY) --rm -v "$(shell pwd)/$(INPUT_DIR)":/data/$(INPUT_DIR) -v "$(shell pwd)/$(OUTPUT_DIR)":/data/$(OUTPUT_DIR) -v "$(CACHE_DIR)":/cache $(IMAGE_NAME) $(INPUT_DIR) --output-dir $(OUTPUT_DIR)

serve: build ## Serve the output directory via HTTP
	$(CONTAINER_RUNTIME) run -it -p 8000:8000 -v "$(shell pwd)/$(OUTPUT_DIR)":/data --entrypoint python $(IMAGE_NAME) /app/serve.py

test-image: ## Build the test Docker image
	$(CONTAINER_RUNTIME) build -f Dockerfile.test -t $(IMAGE_NAME)-test .

test: test-image ## Run tests in Docker
	$(CONTAINER_RUNTIME) run --rm -v "$(shell pwd)/htmlcov":/app/htmlcov -v "$(shell pwd)/coverage":/app/coverage $(IMAGE_NAME)-test

lint: test-image ## Run linters in Docker
	$(CONTAINER_RUNTIME) run --rm -v "$(shell pwd)":/app $(IMAGE_NAME)-test sh -c "ruff check && mypy . && npm run typecheck && npm run lint"

format: test-image ## Run formatters in Docker
	$(CONTAINER_RUNTIME) run --rm -v "$(shell pwd)":/app $(IMAGE_NAME)-test sh -c "ruff format && npm run format"

lint-local: ## Run linters locally
	ruff check .
	mypy .
	npm run typecheck
	npm run lint

format-local: ## Run formatters locally
	ruff format .
	npx prettier --write .

test-local: ## Run tests locally
	npm run test:coverage
	pytest --cov=kml_heatmap --cov-report=term

verify: build ## Verify output directory is up-to-date
	git diff --exit-code $(OUTPUT_DIR)/

check-obfuscation: ## Check KML files are obfuscated
	python -m kml_heatmap.obfuscate $(INPUT_DIR) --check

clean: ## Remove container images and build artifacts
	$(CONTAINER_RUNTIME) rmi $(IMAGE_NAME) $(IMAGE_NAME)-test 2>/dev/null || true
	rm -rf htmlcov coverage
