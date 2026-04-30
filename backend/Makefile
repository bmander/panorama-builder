.PHONY: run build fmt vet tidy schema

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

schema:
	psql '$(DATABASE_URL)' -f schema.sql
