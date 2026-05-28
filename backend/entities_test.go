package main

import (
	"maps"
	"regexp"
	"slices"
	"testing"
)

// entities_test.go guards the two parity drifts the compiler cannot catch.
//
// The three switches that used to drift (insert/update/delete) plus rank,
// fetch, and date-graph membership are now methods on entitySpec, so a new
// entity that forgets one of them won't compile — that class of bug is gone.
// What the compiler still can't see is whether a new entity was wired into all
// of: the entityX const list, entityRegistry, and the session_ops.entity_type
// CHECK constraint. These tests cover that, using the embedded migration SQL as
// independent ground truth so they run on every `go test` (no live DB needed).

// allEntityConsts is the hand-maintained list of every entity_type const. The
// const-coverage test asserts it matches the registry exactly; adding a const
// without a spec (the shape of issue 44's original gap) fails here.
var allEntityConsts = []string{
	entityStation,
	entityPhoto,
	entityImageMeasurement,
	entityControlPoint,
	entityCPConstraint,
	entityCPSurface,
	entityCPObservation,
}

func TestEveryEntityConstIsRegistered(t *testing.T) {
	consts := sliceToSet(allEntityConsts)
	registered := keySet(entityRegistry)
	if !maps.Equal(consts, registered) {
		t.Errorf("allEntityConsts and entityRegistry are out of sync:\n"+
			"  consts:     %v\n"+
			"  registered: %v", sortedKeys(consts), sortedKeys(registered))
	}
	// Each spec must report the const it's keyed under (catches a copy-paste
	// where a spec's entityType() returns the wrong const).
	for et, spec := range entityRegistry {
		if spec.entityType() != et {
			t.Errorf("entityRegistry[%q].entityType() = %q, want %q", et, spec.entityType(), et)
		}
	}
}

// entityTypeInListRe captures the parenthesized value list of an
// `entity_type IN (...)` CHECK. (?s) lets the list span newlines.
var entityTypeInListRe = regexp.MustCompile(`(?s)entity_type\s+IN\s*\(([^)]*)\)`)

// quotedToken matches each 'value' literal inside that list.
var quotedToken = regexp.MustCompile(`'([^']+)'`)

// TestRegistryMatchesMigrationCheckConstraint asserts the registry's entity
// types exactly match the session_ops.entity_type CHECK constraint, read from
// the embedded migration SQL (the latest `entity_type IN (...)` wins, since
// later migrations DROP and re-ADD the constraint). The migration SQL is
// authored independently of the registry — for the DB, not the Go code — so
// this is genuine ground truth, not a second hand-list checked against itself.
// It needs no database, so it runs in CI on every `go test`.
func TestRegistryMatchesMigrationCheckConstraint(t *testing.T) {
	migs, err := loadEmbeddedMigrations() // returned sorted by version ascending
	if err != nil {
		t.Fatalf("load embedded migrations: %v", err)
	}
	var lastList string
	for _, m := range migs {
		for _, match := range entityTypeInListRe.FindAllStringSubmatch(m.sql, -1) {
			lastList = match[1]
		}
	}
	if lastList == "" {
		t.Fatal("no `entity_type IN (...)` CHECK found in embedded migrations")
	}

	want := map[string]struct{}{}
	for _, q := range quotedToken.FindAllStringSubmatch(lastList, -1) {
		want[q[1]] = struct{}{}
	}
	got := keySet(entityRegistry)
	if !maps.Equal(got, want) {
		t.Errorf("entityRegistry is out of sync with the session_ops entity_type CHECK constraint:\n"+
			"  registry has:      %v\n"+
			"  constraint allows: %v\n"+
			"add the missing entity to entityRegistry, or add a migration extending the CHECK constraint",
			sortedKeys(got), sortedKeys(want))
	}
}

func sliceToSet(s []string) map[string]struct{} {
	m := make(map[string]struct{}, len(s))
	for _, v := range s {
		m[v] = struct{}{}
	}
	return m
}

func keySet[V any](m map[string]V) map[string]struct{} {
	out := make(map[string]struct{}, len(m))
	for k := range m {
		out[k] = struct{}{}
	}
	return out
}

func sortedKeys(m map[string]struct{}) []string {
	return slices.Sorted(maps.Keys(m))
}
