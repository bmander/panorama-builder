.PHONY: run build fmt vet tidy generate

DATABASE_URL ?= postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable

run:
	DATABASE_URL='$(DATABASE_URL)' go run .

build:
	go build -o bin/panorama-api .

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
