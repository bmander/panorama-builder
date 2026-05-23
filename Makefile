# Top-level Makefile. Each Go module has its own go.mod and can be
# built/tested independently; this is a coordinator that loops over them.

MODULES := backend solver shared

.PHONY: build vet fmt tidy test typecheck lint

build:
	@set -e; for m in $(MODULES); do echo "==> $$m: go build ./..."; (cd $$m && go build ./...); done

vet:
	@set -e; for m in $(MODULES); do echo "==> $$m: go vet ./..."; (cd $$m && go vet ./...); done

test:
	@set -e; for m in $(MODULES); do echo "==> $$m: go test ./..."; (cd $$m && go test ./...); done

fmt:
	@set -e; for m in $(MODULES); do echo "==> $$m: go fmt ./..."; (cd $$m && go fmt ./...); done

# Per-module `go mod tidy`. Run after changing imports across modules.
tidy:
	@set -e; for m in $(MODULES); do echo "==> $$m: go mod tidy"; (cd $$m && go mod tidy); done

# Frontend gates.
typecheck:
	cd frontend && npm run typecheck

lint:
	cd frontend && npm run lint
