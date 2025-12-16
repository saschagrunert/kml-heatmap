.PHONY: all build serve test-image test test-frontend lint lint-frontend format clean

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

test-frontend: test-image
	$(CONTAINER_RUNTIME) run --rm -v $(shell pwd):/app $(IMAGE_NAME)-test /bin/bash -c "cd kml_heatmap/frontend && npm install && npm test"

lint: test-image
	$(CONTAINER_RUNTIME) run --rm -v $(shell pwd):/app $(IMAGE_NAME)-test ruff check

lint-frontend: test-image
	$(CONTAINER_RUNTIME) run --rm -v $(shell pwd):/app $(IMAGE_NAME)-test /bin/bash -c "cd kml_heatmap/frontend && npm install && npm run lint"

format: test-image
	$(CONTAINER_RUNTIME) run --rm -v $(shell pwd):/app $(IMAGE_NAME)-test ruff format

clean:
	$(CONTAINER_RUNTIME) rmi $(IMAGE_NAME) $(IMAGE_NAME)-test 2>/dev/null || true
	rm -rf kml_heatmap/frontend/node_modules kml_heatmap/frontend/coverage kml_heatmap/static/map.js*
