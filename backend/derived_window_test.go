package main

import (
	"strings"
	"testing"
	"time"
)

func ymd(year int) *time.Time {
	t := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
	return &t
}

// Station with a derived window (no precise captured_at) that's narrowed
// by a `missing` observation against a CP whose lifespan strictly post-
// dates the station's observed-edge upper bound. Branch B (station after
// CP destruction) is infeasible, so the disjunction collapses to Branch A
// (station before CP creation) and the station's upper bound tightens to
// the CP's started_at.
func TestPropagateWindows_Missing_NarrowsDerivedStationWindow(t *testing.T) {
	// Two anchor CPs bracket the missing-station's date via observed
	// edges: c_low forces s.lo ≥ 1865, c_high forces s.hi ≤ 1883.
	cpLow := ControlPoint{ID: "c_low", StartedAt: ymd(1865), EndedAt: ymd(1900)}
	cpHigh := ControlPoint{ID: "c_high", StartedAt: ymd(1850), EndedAt: ymd(1883)}
	// Target CP exists 1878-1914; station is marked missing for it.
	cpTarget := ControlPoint{ID: "c_target", StartedAt: ymd(1878), EndedAt: ymd(1914)}
	sMis := Station{ID: "s_mis"} // captured_at nil

	obs := []CpObservation{
		{ID: "o1", ControlPointID: "c_low", StationID: "s_mis", Status: Observed},
		{ID: "o2", ControlPointID: "c_high", StationID: "s_mis", Status: Observed},
		{ID: "o3", ControlPointID: "c_target", StationID: "s_mis", Status: Missing},
	}

	result := propagateWindows(
		[]ControlPoint{cpLow, cpHigh, cpTarget},
		[]Station{sMis},
		obs,
	)

	got := result.Stations["s_mis"]
	if got.CapturedAtLower == nil || !got.CapturedAtLower.Equal(*ymd(1865)) {
		t.Errorf("captured_at_lower: got %v, want 1865", got.CapturedAtLower)
	}
	if got.CapturedAtUpper == nil || !got.CapturedAtUpper.Equal(*ymd(1878)) {
		t.Errorf("captured_at_upper: got %v, want 1878 (narrowed from 1883 by dominated-branch)", got.CapturedAtUpper)
	}
	if got.Inconsistent {
		t.Error("station should not be inconsistent")
	}
}

// Parity with the prior single-pass heuristic: precise captured_at on
// both observer and missing station, observer later than missing
// → CP's startLo advances to the missing station's date.
func TestPropagateWindows_Missing_PreciseTimesParity(t *testing.T) {
	cp := ControlPoint{ID: "c"} // no precise dates
	sObs := Station{ID: "s_obs", CapturedAt: ymd(1900)}
	sMis := Station{ID: "s_mis", CapturedAt: ymd(1850)}

	obs := []CpObservation{
		{ID: "o1", ControlPointID: "c", StationID: "s_obs", Status: Observed},
		{ID: "o2", ControlPointID: "c", StationID: "s_mis", Status: Missing},
	}

	result := propagateWindows([]ControlPoint{cp}, []Station{sObs, sMis}, obs)

	gotCP := result.CPs["c"]
	if gotCP.StartedAtLower == nil || !gotCP.StartedAtLower.Equal(*ymd(1850)) {
		t.Errorf("cp.started_at_lower: got %v, want 1850", gotCP.StartedAtLower)
	}
	if gotCP.Inconsistent {
		t.Error("CP should not be inconsistent")
	}
}

// Both disjuncts infeasible: precise CP 1860-1900, missing station
// precisely at 1880 inside the lifespan. Contradiction flags both.
func TestPropagateWindows_Missing_BothBranchesInfeasible(t *testing.T) {
	cp := ControlPoint{ID: "c", StartedAt: ymd(1860), EndedAt: ymd(1900)}
	s := Station{ID: "s", CapturedAt: ymd(1880)}

	obs := []CpObservation{
		{ID: "o", ControlPointID: "c", StationID: "s", Status: Missing},
	}

	result := propagateWindows([]ControlPoint{cp}, []Station{s}, obs)

	if !result.CPs["c"].Inconsistent {
		t.Error("CP should be flagged inconsistent")
	}
	if !result.Stations["s"].Inconsistent {
		t.Error("station should be flagged inconsistent")
	}
}

// Both disjuncts feasible: unconstrained station, precise CP. No
// narrowing happens until something else tightens the station's bounds.
func TestPropagateWindows_Missing_BothBranchesFeasible(t *testing.T) {
	cp := ControlPoint{ID: "c", StartedAt: ymd(1878), EndedAt: ymd(1914)}
	s := Station{ID: "s"} // no precise captured_at, no observed anchors

	obs := []CpObservation{
		{ID: "o", ControlPointID: "c", StationID: "s", Status: Missing},
	}

	result := propagateWindows([]ControlPoint{cp}, []Station{s}, obs)

	gotSt := result.Stations["s"]
	if gotSt.CapturedAtLower != nil {
		t.Errorf("station.captured_at_lower: got %v, want nil", gotSt.CapturedAtLower)
	}
	if gotSt.CapturedAtUpper != nil {
		t.Errorf("station.captured_at_upper: got %v, want nil", gotSt.CapturedAtUpper)
	}
	if gotSt.Inconsistent {
		t.Error("station should not be inconsistent")
	}
	if result.CPs["c"].Inconsistent {
		t.Error("CP should not be inconsistent")
	}
}

// --- explainInconsistency ---

// joinTexts is a test helper that concatenates the Text field of every
// reason for substring assertions.
func joinTexts(reasons []InconsistencyReason) string {
	parts := make([]string, len(reasons))
	for i, r := range reasons {
		parts[i] = r.Text
	}
	return strings.Join(parts, " | ")
}

func joinSources(reasons []InconsistencyReason) string {
	var parts []string
	for _, r := range reasons {
		parts = append(parts, r.BoundSources...)
	}
	return strings.Join(parts, " | ")
}

// Assertion is intentionally permissive: depending on propagation order
// only the "downstream" Leq surfaces as infeasible; the upstream cause
// shows up implicitly via the bound values cited in the reason.
func TestExplainInconsistency_StationObservedNonOverlappingCPs(t *testing.T) {
	cpA := ControlPoint{ID: "c_a", Description: "A", StartedAt: ymd(1860), EndedAt: ymd(1880)}
	cpB := ControlPoint{ID: "c_b", Description: "B", StartedAt: ymd(1890), EndedAt: ymd(1900)}
	st := Station{ID: "s"}

	obs := []CpObservation{
		{ID: "o1", ControlPointID: "c_a", StationID: "s", Status: Observed},
		{ID: "o2", ControlPointID: "c_b", StationID: "s", Status: Observed},
	}

	reasons, found := explainStationInconsistency("s", []ControlPoint{cpA, cpB}, []Station{st}, obs)
	if !found {
		t.Fatal("station not found in graph")
	}
	if len(reasons) == 0 {
		t.Fatal("expected at least one reason for inconsistent station; got empty")
	}
	texts := joinTexts(reasons)
	if !strings.Contains(texts, `"A"`) && !strings.Contains(texts, `"B"`) {
		t.Errorf("expected at least one CP description (A or B) in reasons, got: %v", reasons)
	}
	if !strings.Contains(texts, "observed CP") {
		t.Errorf("expected observed-edge contradiction text, got %v", reasons)
	}
}

func TestExplainInconsistency_CPInvertedLifespan(t *testing.T) {
	cp := ControlPoint{ID: "c", Description: "Inverted", StartedAt: ymd(1900), EndedAt: ymd(1850)}

	reasons, found := explainControlPointInconsistency("c", []ControlPoint{cp}, []Station{}, []CpObservation{})
	if !found {
		t.Fatal("CP not found in graph")
	}
	if len(reasons) != 1 {
		t.Fatalf("expected 1 reason, got %d: %v", len(reasons), reasons)
	}
	if !strings.Contains(reasons[0].Text, "started_at lower bound") || !strings.Contains(reasons[0].Text, "ended_at upper bound") {
		t.Errorf("expected lifespan-validity contradiction text, got %q", reasons[0].Text)
	}
}

func TestExplainInconsistency_StationMissingObservationContradicted(t *testing.T) {
	cp := ControlPoint{ID: "c", Description: "C", StartedAt: ymd(1860), EndedAt: ymd(1900)}
	st := Station{ID: "s", CapturedAt: ymd(1880)}

	obs := []CpObservation{
		{ID: "o", ControlPointID: "c", StationID: "s", Status: Missing},
	}

	reasons, found := explainStationInconsistency("s", []ControlPoint{cp}, []Station{st}, obs)
	if !found {
		t.Fatal("station not found in graph")
	}
	if len(reasons) != 1 {
		t.Fatalf("expected 1 reason, got %d: %v", len(reasons), reasons)
	}
	if !strings.Contains(reasons[0].Text, "missing") {
		t.Errorf("expected missing-constraint text, got %q", reasons[0].Text)
	}
}

func TestExplainInconsistency_ConsistentReturnsEmpty(t *testing.T) {
	cp := ControlPoint{ID: "c", StartedAt: ymd(1860), EndedAt: ymd(1900)}
	st := Station{ID: "s", CapturedAt: ymd(1880)}
	obs := []CpObservation{
		{ID: "o", ControlPointID: "c", StationID: "s", Status: Observed},
	}

	reasons, found := explainStationInconsistency("s", []ControlPoint{cp}, []Station{st}, obs)
	if !found {
		t.Error("station should be found")
	}
	if len(reasons) != 0 {
		t.Errorf("expected empty reasons for consistent station, got %v", reasons)
	}
	reasons, found = explainControlPointInconsistency("c", []ControlPoint{cp}, []Station{st}, obs)
	if !found {
		t.Error("CP should be found")
	}
	if len(reasons) != 0 {
		t.Errorf("expected empty reasons for consistent CP, got %v", reasons)
	}
}

// Three observations jointly contradict: an "anchor" CP whose
// observed-end pulls station.captured_at.hi to 1899, "Stetson" whose
// observed-start pushes station.captured_at.lo to 1890, and a
// "sisters of mercy" CP marked missing whose lifespan (1880–1920)
// straddles the resulting [1890, 1899] window — neither branch of its
// disjunction is feasible, so the missing-edge surfaces as the
// violation. Its bound_sources must cite BOTH the observed Stetson
// (source of s.t.lo) and the observed anchor (source of s.t.hi) — the
// two upstream observations causing the contradiction.
func TestExplainInconsistency_BlameSurfacesUpstreamObservations(t *testing.T) {
	cpAnchor := ControlPoint{ID: "c_anchor", Description: "anchor", StartedAt: ymd(1860), EndedAt: ymd(1899)}
	cpMissing := ControlPoint{ID: "c_missing", Description: "sisters of mercy", StartedAt: ymd(1880), EndedAt: ymd(1920)}
	cpLate := ControlPoint{ID: "c_late", Description: "Stetson", StartedAt: ymd(1890), EndedAt: ymd(1900)}
	st := Station{ID: "s", Name: ptr("nw lookout")}

	obs := []CpObservation{
		{ID: "o1", ControlPointID: "c_anchor", StationID: "s", Status: Observed},
		{ID: "o2", ControlPointID: "c_missing", StationID: "s", Status: Missing},
		{ID: "o3", ControlPointID: "c_late", StationID: "s", Status: Observed},
	}

	reasons, found := explainStationInconsistency("s", []ControlPoint{cpAnchor, cpMissing, cpLate}, []Station{st}, obs)
	if !found {
		t.Fatal("station not found in graph")
	}
	if len(reasons) == 0 {
		t.Fatal("expected at least one reason")
	}
	texts := joinTexts(reasons)
	if !strings.Contains(texts, "sisters of mercy") || !strings.Contains(texts, "missing") {
		t.Errorf("expected violated reason to be the missing-edge for sisters of mercy, got: %q", texts)
	}
	sources := joinSources(reasons)
	if !strings.Contains(sources, "Stetson") {
		t.Errorf("expected bound_sources to attribute a station bound to the observed Stetson CP, got: %q", sources)
	}
	if !strings.Contains(sources, "anchor") {
		t.Errorf("expected bound_sources to attribute a station bound to the observed anchor CP, got: %q", sources)
	}
}

func ptr[T any](v T) *T { return &v }
