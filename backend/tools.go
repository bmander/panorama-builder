//go:build tools

// Build-time deps. The `tools` build tag keeps these out of the production
// binary while letting `go mod tidy` retain them in go.sum so `make generate`
// can `go run` them deterministically.
package main

import _ "github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen"
