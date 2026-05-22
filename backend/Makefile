.PHONY: run build build-reader build-editor docker-reader docker-editor run-reader run-editor fmt vet tidy generate dump restore

DATABASE_URL ?= postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable
DUMP_FILE    ?= panorama_$(shell date -u +%Y%m%dT%H%M%SZ).sql

# Links Ceres-Solver via cgo (see backend/solver/bridge.cc). Prereqs:
#   macOS:  brew install ceres-solver eigen suite-sparse glog gflags
#   Linux:  apt install libceres-dev libeigen3-dev libsuitesparse-dev \
#                       libgoogle-glog-dev libgflags-dev
run:
	DATABASE_URL='$(DATABASE_URL)' go run .

build:
	go build -o bin/panorama-api .

# Reader binary: no cgo, no Ceres linkage — for the read-only Cloud Run
# service. Solver routes don't exist in this build (router_solve_stub.go).
build-reader:
	CGO_ENABLED=0 go build -tags noceres -o bin/panorama-reader .

# Editor binary: full build, links Ceres-Solver via cgo. Same as `make build`
# but with an explicit name to mirror build-reader.
build-editor:
	go build -o bin/panorama-editor .

# Docker images for Cloud Run. Reader = distroless static (~55 MB). Editor =
# debian-slim + libceres3 runtime (~240 MB). Built from backend/ context.
docker-reader:
	docker build -f Dockerfile.reader -t panorama-reader:dev .

docker-editor:
	docker build -f Dockerfile.editor -t panorama-editor:dev .

# Run a built image locally against the host Postgres (Docker Desktop's
# host.docker.internal) and the local data/ + ../frontend/dist mounts.
# Override DATABASE_URL if pointing elsewhere.
DOCKER_DB_URL ?= postgres://panorama:panorama@host.docker.internal:5432/panorama?sslmode=disable
run-reader:
	docker rm -f pan-reader 2>/dev/null; true
	docker run --rm -it --name pan-reader -p 8080:8080 \
	  -e DATABASE_URL='$(DOCKER_DB_URL)' \
	  -e STORAGE_DIR=/data -e STATIC_DIR=/static \
	  -v $(PWD)/data:/data -v $(PWD)/../frontend/dist:/static:ro \
	  panorama-reader:dev

run-editor:
	docker rm -f pan-editor 2>/dev/null; true
	docker run --rm -it --name pan-editor -p 8080:8080 \
	  -e DATABASE_URL='$(DOCKER_DB_URL)' \
	  -e STORAGE_DIR=/data -e STATIC_DIR=/static \
	  -v $(PWD)/data:/data -v $(PWD)/../frontend/dist:/static:ro \
	  panorama-editor:dev

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
