.PHONY: all build serve test-image test lint format clean

STADIA_API_KEY ?=
OPENAIP_API_KEY ?=
CONTAINER_RUNTIME ?= docker
IMAGE_NAME := kml-heatmap
OUTPUT_DIR := docs

all: build

build:
	$(CONTAINER_RUNTIME) build -t $(IMAGE_NAME) .
	$(CONTAINER_RUNTIME) run -e STADIA_API_KEY=$(STADIA_API_KEY) -e OPENAIP_API_KEY=$(OPENAIP_API_KEY) --rm -v $(shell pwd):/data $(IMAGE_NAME) --output-dir $(OUTPUT_DIR) kml

serve:
	$(CONTAINER_RUNTIME) run -it -p 8000:8000 -v $(shell pwd)/$(OUTPUT_DIR):/data --entrypoint python $(IMAGE_NAME) /app/serve.py

test-image:
	$(CONTAINER_RUNTIME) build -f Dockerfile.test -t $(IMAGE_NAME)-test .

test: test-image
	$(CONTAINER_RUNTIME) run --rm -v $(shell pwd)/htmlcov:/app/htmlcov $(IMAGE_NAME)-test

lint: test-image
	$(CONTAINER_RUNTIME) run --rm -v $(shell pwd):/app $(IMAGE_NAME)-test ruff check

format: test-image
	$(CONTAINER_RUNTIME) run --rm -v $(shell pwd):/app $(IMAGE_NAME)-test ruff format

clean:
	$(CONTAINER_RUNTIME) rmi $(IMAGE_NAME) $(IMAGE_NAME)-test 2>/dev/null || true
