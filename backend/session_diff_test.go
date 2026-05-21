package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

// keysOf returns the set of top-level JSON keys in obj, or nil for empty.
func keysOf(t *testing.T, obj []byte) map[string]bool {
	t.Helper()
	if len(obj) == 0 {
		return nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(obj, &m); err != nil {
		t.Fatalf("unmarshal %q: %v", obj, err)
	}
	out := map[string]bool{}
	for k := range m {
		out[k] = true
	}
	return out
}

func assertKeys(t *testing.T, got []byte, want []string) {
	t.Helper()
	gotSet := keysOf(t, got)
	if len(gotSet) != len(want) {
		t.Fatalf("got keys %v, want %v (raw: %s)", gotSet, want, got)
	}
	for _, k := range want {
		if !gotSet[k] {
			t.Fatalf("missing key %q in %s", k, got)
		}
	}
}

func TestColumnDiff_EqualReturnsNil(t *testing.T) {
	a := []byte(`{"lat":47.5,"lng":-122.3,"alt":10}`)
	b := []byte(`{"lat":47.5,"lng":-122.3,"alt":10}`)
	beforeDiff, afterDiff := columnDiff(a, b)
	if beforeDiff != nil || afterDiff != nil {
		t.Fatalf("expected (nil,nil), got (%s,%s)", beforeDiff, afterDiff)
	}
}

func TestColumnDiff_SingleColumnChange(t *testing.T) {
	a := []byte(`{"lat":47.5,"lng":-122.3,"alt":10}`)
	b := []byte(`{"lat":48.0,"lng":-122.3,"alt":10}`)
	before, after := columnDiff(a, b)
	assertKeys(t, before, []string{"lat"})
	assertKeys(t, after, []string{"lat"})
}

func TestColumnDiff_NestedObjectChange(t *testing.T) {
	a := []byte(`{"lat":47.5,"derived_window":{"inconsistent":false}}`)
	b := []byte(`{"lat":47.5,"derived_window":{"inconsistent":true}}`)
	before, after := columnDiff(a, b)
	assertKeys(t, before, []string{"derived_window"})
	assertKeys(t, after, []string{"derived_window"})
}

func TestCoalesceUpdateDiff_BeforeKeepsEarliestAfterKeepsLatest(t *testing.T) {
	// Existing op moved lat 1→2. New op moves lat 2→9 and adds alt 0→3.
	// Coalesced: before should keep earliest lat (1) and pick up new alt (0);
	// after should hold the latest lat (9) and the new alt (3).
	before, after := coalesceUpdateDiff(
		[]byte(`{"lat":1}`), []byte(`{"lat":2}`),
		[]byte(`{"lat":2,"alt":0}`), []byte(`{"lat":9,"alt":3}`),
	)
	var b, a map[string]json.RawMessage
	_ = json.Unmarshal(before, &b)
	_ = json.Unmarshal(after, &a)
	if !bytes.Equal(b["lat"], []byte("1")) {
		t.Fatalf("expected before.lat=1 (earliest), got %s", b["lat"])
	}
	if !bytes.Equal(a["lat"], []byte("9")) {
		t.Fatalf("expected after.lat=9 (latest), got %s", a["lat"])
	}
	if !bytes.Equal(b["alt"], []byte("0")) || !bytes.Equal(a["alt"], []byte("3")) {
		t.Fatalf("expected alt 0→3, got %s→%s", b["alt"], a["alt"])
	}
}

func TestCoalesceUpdateDiff_RoundTripCancels(t *testing.T) {
	// Existing op moved name A→B. New op moves it B→A. Net diff: empty.
	before, after := coalesceUpdateDiff(
		[]byte(`{"name":"A"}`), []byte(`{"name":"B"}`),
		[]byte(`{"name":"B"}`), []byte(`{"name":"A"}`),
	)
	if before != nil || after != nil {
		t.Fatalf("expected (nil,nil), got (%s,%s)", before, after)
	}
}

func TestTrimColumnDiffToChanged_DropsEqualColumns(t *testing.T) {
	before := []byte(`{"lat":1,"lng":2}`)
	after := []byte(`{"lat":1,"lng":9}`)
	b, a := trimColumnDiffToChanged(before, after)
	assertKeys(t, b, []string{"lng"})
	assertKeys(t, a, []string{"lng"})
}

func TestTrimColumnDiffToChanged_EmptyResult(t *testing.T) {
	before := []byte(`{"lat":1}`)
	after := []byte(`{"lat":1}`)
	b, a := trimColumnDiffToChanged(before, after)
	if b != nil || a != nil {
		t.Fatalf("expected (nil,nil), got (%s,%s)", b, a)
	}
}

func TestMergeFullRowWithDiff_OverlaysChangedColumns(t *testing.T) {
	full := []byte(`{"lat":1,"lng":2,"alt":3}`)
	diff := []byte(`{"lat":99}`)
	got := mergeFullRowWithDiff(full, diff)
	var m map[string]json.RawMessage
	_ = json.Unmarshal(got, &m)
	if !bytes.Equal(m["lat"], []byte("99")) {
		t.Fatalf("expected lat=99, got %s", m["lat"])
	}
	if !bytes.Equal(m["lng"], []byte("2")) {
		t.Fatalf("expected lng=2 (unchanged), got %s", m["lng"])
	}
	if !bytes.Equal(m["alt"], []byte("3")) {
		t.Fatalf("expected alt=3 (unchanged), got %s", m["alt"])
	}
}

func TestSliceColumns_SubsetByKeys(t *testing.T) {
	full := []byte(`{"lat":1,"lng":2,"alt":3,"name":"x"}`)
	keys := map[string]json.RawMessage{"lat": nil, "alt": nil}
	got := sliceColumns(full, keys)
	assertKeys(t, got, []string{"lat", "alt"})
}
