.PHONY: run build docker-api docker-solver split-up split-down fmt vet tidy generate dump restore

DATABASE_URL ?= postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable
DUMP_FILE    ?= panorama_$(shell date -u +%Y%m%dT%H%M%SZ).sql

# The api binary is pure-Go — no cgo, no Ceres. It proxies solves to a
# separate solver process via SOLVER_URL. For the full app locally use
# `make split-up` (docker compose) instead.
run:
	DATABASE_URL='$(DATABASE_URL)' go run .

build:
	CGO_ENABLED=0 go build -o bin/panorama-api .

# Docker images for Cloud Run.
#   api    = distroless-static + bundled frontend, ~60 MB.
#   solver = debian-slim + libceres3, ~240 MB.
# Build context = repo root so each image can see its sibling shared/ for
# the `replace ../shared` directive.
docker-api:
	cd .. && docker build -f backend/Dockerfile -t panorama-api:dev .

docker-solver:
	cd .. && docker build -f solver/Dockerfile -t panorama-solver:dev .

# Bring up the prod-like layout locally: postgres + api (:8080, browser
# origin) + solver (no host port, private network only). Frontend must be
# built first:  (cd ../frontend && npm run build)
split-up:
	docker compose --profile app up -d --build

split-down:
	docker compose --profile app down

fmt:
	go fmt ./...

vet:
	go vet ./...

tidy:
	go mod tidy

# Regenerates types.gen.go (Go) and ../frontend/src/api-types.gen.ts (TS)
# from ../openapi.yaml. Run after editing the spec; commit both files.
generate:
	go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen \
	  -config oapi-codegen.yaml ../openapi.yaml
	cd ../frontend && npm run generate-types

# Dump the running postgres container to a plain-SQL file.
# Override the destination with: make dump DUMP_FILE=path/to/backup.sql
dump:
	@docker compose exec -T postgres pg_dump -U panorama -d panorama --no-owner --no-acl > $(DUMP_FILE)
	@echo "Wrote $(DUMP_FILE)"

# Restore a plain-SQL dump into the running postgres container.
# Requires DUMP_FILE=path/to/backup.sql. Drops and recreates the public schema first.
restore:
	@test -n "$(DUMP_FILE)" -a -f "$(DUMP_FILE)" || (echo "Usage: make restore DUMP_FILE=path/to/backup.sql" && exit 1)
	@docker compose exec -T postgres psql -U panorama -d panorama -v ON_ERROR_STOP=1 \
	  -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
	@docker compose exec -T postgres psql -U panorama -d panorama -v ON_ERROR_STOP=1 < $(DUMP_FILE)
	@echo "Restored $(DUMP_FILE)"
