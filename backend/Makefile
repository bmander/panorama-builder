.PHONY: run build build-api build-solver docker-api docker-solver split-up split-down fmt vet tidy generate dump restore

DATABASE_URL ?= postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable
DUMP_FILE    ?= panorama_$(shell date -u +%Y%m%dT%H%M%SZ).sql

# Links Ceres-Solver via cgo (see backend/solver/bridge.cc). Prereqs:
#   macOS:  brew install ceres-solver eigen suite-sparse glog gflags
#   Linux:  apt install libceres-dev libeigen3-dev libsuitesparse-dev \
#                       libgoogle-glog-dev libgflags-dev
#
# Note: `go run .` here builds the API binary, which proxies solves to a
# separate solver process via SOLVER_URL. For the full app locally use
# `make split-up` (docker compose) instead.
run:
	DATABASE_URL='$(DATABASE_URL)' go run .

build:
	go build -o bin/panorama-api .

# API binary: pure-Go, no cgo, no Ceres. Forwards solves to the private
# solver service via SOLVER_URL. Suitable for distroless-static.
build-api:
	CGO_ENABLED=0 go build -tags noceres -o bin/panorama-api .

# Solver binary: full build with cgo + Ceres. Private microservice (no DB,
# no sessions); only the api service calls it. See cmd/solver/.
build-solver:
	go build -o bin/panorama-solver ./cmd/solver

# Docker images for Cloud Run.
#   api    = distroless-static, ~55 MB.
#   solver = debian-slim + libceres3, ~240 MB.
docker-api:
	docker build -f Dockerfile.api -t panorama-api:dev .

docker-solver:
	docker build -f Dockerfile.solver -t panorama-solver:dev .

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
