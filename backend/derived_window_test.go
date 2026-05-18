package main

import (
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
