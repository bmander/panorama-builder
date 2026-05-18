package stn

import (
	"fmt"
	"testing"
)

func ip(n int64) *int64 { return &n }

func eqp(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// --- Engine / Solver mechanics ---

func TestSolver_Empty(t *testing.T) {
	s := New[int64]()
	s.Propagate()
	if len(s.Variables()) != 0 {
		t.Errorf("Variables: got %d, want 0", len(s.Variables()))
	}
}

func TestSolver_StableIndices(t *testing.T) {
	s := New[int64]()
	for i := 0; i < 5; i++ {
		if got := s.AddVar(); got != i {
			t.Errorf("AddVar #%d: got %d, want %d", i, got, i)
		}
	}
	if len(s.Variables()) != 5 {
		t.Fatalf("Variables length: got %d, want 5", len(s.Variables()))
	}
	held := s.Variables()[0]
	s.AddVar()
	s.AddConstraint(Leq[int64]{A: 0, B: 1})
	if held != s.Variables()[0] {
		t.Error("variable pointer changed after AddVar/AddConstraint — callers cannot hold refs")
	}
}

func TestSolver_IdempotentAtFixedPoint(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(1), ip(1)
	s.Variables()[b].Lo, s.Variables()[b].Hi = ip(5), ip(5)
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	snap := []Variable[int64]{*s.Variables()[a], *s.Variables()[b]}
	s.Propagate()
	if *s.Variables()[a] != snap[0] || *s.Variables()[b] != snap[1] {
		t.Error("second Propagate moved bounds")
	}
}

func TestSolver_OrderIndependent(t *testing.T) {
	build := func(reverse bool) []Variable[int64] {
		s := New[int64]()
		a, b, c := s.AddVar(), s.AddVar(), s.AddVar()
		s.Variables()[a].Lo, s.Variables()[a].Hi = ip(1), ip(1)
		s.Variables()[c].Lo, s.Variables()[c].Hi = ip(10), ip(10)
		cons := []Constraint[int64]{Leq[int64]{A: a, B: b}, Leq[int64]{A: b, B: c}}
		if reverse {
			cons[0], cons[1] = cons[1], cons[0]
		}
		for _, x := range cons {
			s.AddConstraint(x)
		}
		s.Propagate()
		return []Variable[int64]{*s.Variables()[a], *s.Variables()[b], *s.Variables()[c]}
	}
	fwd, bwd := build(false), build(true)
	for i := range fwd {
		if !eqp(fwd[i].Lo, bwd[i].Lo) || !eqp(fwd[i].Hi, bwd[i].Hi) {
			t.Errorf("var %d differs by addition order: %+v vs %+v", i, fwd[i], bwd[i])
		}
	}
}

func TestSolver_TransitivePropagation(t *testing.T) {
	s := New[int64]()
	a, b, c := s.AddVar(), s.AddVar(), s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(1), ip(1)
	s.Variables()[c].Lo, s.Variables()[c].Hi = ip(10), ip(10)
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.AddConstraint(Leq[int64]{A: b, B: c})
	s.Propagate()
	bv := s.Variables()[b]
	if !eqp(bv.Lo, ip(1)) || !eqp(bv.Hi, ip(10)) {
		t.Errorf("B: got [%v, %v], want [1, 10]", bv.Lo, bv.Hi)
	}
}

// inconsistencyFlagger flips Inconsistent without moving Lo/Hi. Used to
// verify the worklist re-enqueues neighbors on inconsistency flips.
type inconsistencyFlagger struct{ V int }

func (f inconsistencyFlagger) Variables() []int                      { return []int{f.V} }
func (f inconsistencyFlagger) Feasible(vars []*Variable[int64]) bool { return true }
func (f inconsistencyFlagger) Narrow(vars []*Variable[int64]) []int {
	if vars[f.V].Inconsistent {
		return nil
	}
	vars[f.V].Inconsistent = true
	return []int{f.V}
}

// runCounter is a no-op constraint that counts how many times Narrow ran.
type runCounter struct {
	V    int
	runs *int
}

func (r runCounter) Variables() []int                      { return []int{r.V} }
func (r runCounter) Feasible(vars []*Variable[int64]) bool { return true }
func (r runCounter) Narrow(vars []*Variable[int64]) []int  { *r.runs++; return nil }

func TestSolver_ReFiresOnInconsistencyFlip(t *testing.T) {
	s := New[int64]()
	v := s.AddVar()
	runs := 0
	s.AddConstraint(inconsistencyFlagger{V: v})
	s.AddConstraint(runCounter{V: v, runs: &runs})
	s.Propagate()
	if !s.Variables()[v].Inconsistent {
		t.Fatal("variable should be inconsistent")
	}
	if runs < 2 {
		t.Errorf("neighbor runCounter ran %d times; expected ≥2 (initial + after flip)", runs)
	}
}

func TestSolver_NoSpinOnQuiescent(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(1), ip(1)
	s.Variables()[b].Lo, s.Variables()[b].Hi = ip(5), ip(5)
	runs := 0
	s.AddConstraint(runCounter{V: a, runs: &runs})
	s.AddConstraint(runCounter{V: b, runs: &runs})
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	if runs > 10 {
		t.Errorf("runCounters ran %d times; want bounded by a small constant", runs)
	}
}

// --- Leq ---

func TestLeq_BasicNarrowing(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo = ip(3)
	s.Variables()[b].Hi = ip(7)
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	if !eqp(s.Variables()[a].Hi, ip(7)) {
		t.Errorf("A.Hi: got %v, want 7", s.Variables()[a].Hi)
	}
	if !eqp(s.Variables()[b].Lo, ip(3)) {
		t.Errorf("B.Lo: got %v, want 3", s.Variables()[b].Lo)
	}
}

func TestLeq_AllUnbounded(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	for i, v := range s.Variables() {
		if v.Lo != nil || v.Hi != nil || v.Inconsistent {
			t.Errorf("var %d: got %+v, want zero", i, v)
		}
	}
}

func TestLeq_OneSideUnbounded(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo = ip(5)
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	if !eqp(s.Variables()[b].Lo, ip(5)) {
		t.Errorf("B.Lo: got %v, want 5", s.Variables()[b].Lo)
	}
	if s.Variables()[b].Hi != nil {
		t.Errorf("B.Hi: got %v, want nil", s.Variables()[b].Hi)
	}
}

func TestLeq_InfeasibilityFlagsBoth(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(10), ip(10)
	s.Variables()[b].Lo, s.Variables()[b].Hi = ip(5), ip(5)
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	if !s.Variables()[a].Inconsistent {
		t.Error("A should be inconsistent")
	}
	if !s.Variables()[b].Inconsistent {
		t.Error("B should be inconsistent")
	}
}

func TestLeq_InconsistencyIsSticky(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(10), ip(10)
	s.Variables()[b].Lo, s.Variables()[b].Hi = ip(5), ip(5)
	leq := Leq[int64]{A: a, B: b}
	s.AddConstraint(leq)
	s.Propagate()
	if changed := leq.Narrow(s.Variables()); len(changed) != 0 {
		t.Errorf("second Narrow returned changed %v; want nil", changed)
	}
}

func TestLeq_SelfLoop(t *testing.T) {
	s := New[int64]()
	a := s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(5), ip(5)
	s.AddConstraint(Leq[int64]{A: a, B: a})
	s.Propagate()
	v := s.Variables()[a]
	if !eqp(v.Lo, ip(5)) || !eqp(v.Hi, ip(5)) || v.Inconsistent {
		t.Errorf("self-loop changed var: got %+v", v)
	}
}

func TestLeq_RedundantConstraints(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo = ip(3)
	s.Variables()[b].Hi = ip(7)
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	if !eqp(s.Variables()[a].Hi, ip(7)) || !eqp(s.Variables()[b].Lo, ip(3)) {
		t.Error("redundant Leq broke narrowing")
	}
}

// --- Disjunction ---

func TestDisjunction_CommitsToSoleFeasible(t *testing.T) {
	// x in [-5, 5]: x ≤ 0 is feasible, 100 ≤ x is not.
	s := New[int64]()
	low := s.AddVar()
	s.Variables()[low].Lo, s.Variables()[low].Hi = ip(0), ip(0)
	high := s.AddVar()
	s.Variables()[high].Lo, s.Variables()[high].Hi = ip(100), ip(100)
	x := s.AddVar()
	s.Variables()[x].Lo, s.Variables()[x].Hi = ip(-5), ip(5)
	s.AddConstraint(Disjunction[int64]{Alts: []Constraint[int64]{
		Leq[int64]{A: x, B: low},  // x ≤ 0 (feasible: x.Lo = -5)
		Leq[int64]{A: high, B: x}, // 100 ≤ x (infeasible: x.Hi = 5)
	}})
	s.Propagate()
	if !eqp(s.Variables()[x].Hi, ip(0)) {
		t.Errorf("x.Hi: got %v, want 0 (narrowed by sole feasible 'x ≤ 0' branch)", s.Variables()[x].Hi)
	}
}

func TestDisjunction_BothFeasibleNoOp(t *testing.T) {
	s := New[int64]()
	a := s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(0), ip(100)
	mid := s.AddVar()
	s.Variables()[mid].Lo, s.Variables()[mid].Hi = ip(50), ip(50)
	s.AddConstraint(Disjunction[int64]{Alts: []Constraint[int64]{
		Leq[int64]{A: mid, B: a}, // 50 ≤ a (feasible: a could be 50-100)
		Leq[int64]{A: a, B: mid}, // a ≤ 50 (feasible: a could be 0-50)
	}})
	s.Propagate()
	av := s.Variables()[a]
	if !eqp(av.Lo, ip(0)) || !eqp(av.Hi, ip(100)) || av.Inconsistent {
		t.Errorf("a: got %+v, want unchanged [0,100], not inconsistent", av)
	}
}

func TestDisjunction_NoneFeasibleFlagsAll(t *testing.T) {
	s := New[int64]()
	cstart := s.AddVar()
	s.Variables()[cstart].Lo, s.Variables()[cstart].Hi = ip(1860), ip(1860)
	cend := s.AddVar()
	s.Variables()[cend].Lo, s.Variables()[cend].Hi = ip(1900), ip(1900)
	st := s.AddVar()
	s.Variables()[st].Lo, s.Variables()[st].Hi = ip(1880), ip(1880)
	s.AddConstraint(Disjunction[int64]{Alts: []Constraint[int64]{
		Leq[int64]{A: st, B: cstart}, // st ≤ 1860 (infeasible: st = 1880)
		Leq[int64]{A: cend, B: st},   // 1900 ≤ st (infeasible: st = 1880)
	}})
	s.Propagate()
	for i, v := range s.Variables() {
		if !v.Inconsistent {
			t.Errorf("var %d (%+v) should be inconsistent", i, v)
		}
	}
}

func TestDisjunction_VariablesUnionDedup(t *testing.T) {
	d := Disjunction[int64]{Alts: []Constraint[int64]{
		Leq[int64]{A: 0, B: 1},
		Leq[int64]{A: 1, B: 2},
	}}
	vars := d.Variables()
	if len(vars) != 3 {
		t.Errorf("Variables: got %d (%v), want 3", len(vars), vars)
	}
	seen := map[int]bool{}
	for _, v := range vars {
		if seen[v] {
			t.Errorf("duplicate index %d", v)
		}
		seen[v] = true
	}
}

func TestDisjunction_SingleAltDegenerates(t *testing.T) {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	s.Variables()[a].Lo = ip(3)
	s.Variables()[b].Hi = ip(7)
	s.AddConstraint(Disjunction[int64]{Alts: []Constraint[int64]{Leq[int64]{A: a, B: b}}})
	s.Propagate()
	if !eqp(s.Variables()[a].Hi, ip(7)) || !eqp(s.Variables()[b].Lo, ip(3)) {
		t.Error("single-alt disjunction didn't behave like the bare Leq")
	}
}

func TestDisjunction_EmptyAlts(t *testing.T) {
	s := New[int64]()
	a := s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(5), ip(5)
	d := Disjunction[int64]{Alts: nil}
	if d.Feasible(s.Variables()) {
		t.Error("empty disjunction should be vacuously infeasible")
	}
	s.AddConstraint(d)
	s.Propagate()
	if s.Variables()[a].Inconsistent {
		t.Error("unrelated variable should not be touched by empty disjunction")
	}
}

func TestDisjunction_ReNarrowsAsBoundsTighten(t *testing.T) {
	// Both branches start feasible; a neighbor Leq tightens st.Hi enough
	// to dominate Branch B; the disjunction must then commit to Branch A.
	s := New[int64]()
	cstart := s.AddVar()
	s.Variables()[cstart].Lo, s.Variables()[cstart].Hi = ip(1878), ip(1878)
	cend := s.AddVar()
	s.Variables()[cend].Lo, s.Variables()[cend].Hi = ip(1914), ip(1914)
	st := s.AddVar()
	anchor := s.AddVar()
	s.Variables()[anchor].Lo, s.Variables()[anchor].Hi = ip(1883), ip(1883)
	s.AddConstraint(Leq[int64]{A: st, B: anchor}) // st ≤ 1883
	s.AddConstraint(Disjunction[int64]{Alts: []Constraint[int64]{
		Leq[int64]{A: st, B: cstart}, // st ≤ 1878 (Branch A)
		Leq[int64]{A: cend, B: st},   // 1914 ≤ st (Branch B; becomes infeasible after st.Hi ≤ 1883)
	}})
	s.Propagate()
	if !eqp(s.Variables()[st].Hi, ip(1878)) {
		t.Errorf("st.Hi: got %v, want 1878 (Branch A committed after anchor tightened)", s.Variables()[st].Hi)
	}
}

func TestDisjunction_Nested(t *testing.T) {
	s := New[int64]()
	a := s.AddVar()
	s.Variables()[a].Lo, s.Variables()[a].Hi = ip(50), ip(50)
	b := s.AddVar()
	s.Variables()[b].Lo, s.Variables()[b].Hi = ip(0), ip(100)
	inner := Disjunction[int64]{Alts: []Constraint[int64]{Leq[int64]{A: a, B: b}}}
	outer := Disjunction[int64]{Alts: []Constraint[int64]{inner}}
	s.AddConstraint(outer)
	s.Propagate()
	if !eqp(s.Variables()[b].Lo, ip(50)) {
		t.Errorf("nested narrowing failed: b.Lo = %v, want 50", s.Variables()[b].Lo)
	}
}

// --- Documentation examples (compiled + run by `go test`) ---

func ExampleSolver() {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	lo, hi := int64(3), int64(7)
	s.Variables()[a].Lo = &lo
	s.Variables()[b].Hi = &hi
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	fmt.Printf("a: [%d, %d]\n", *s.Variables()[a].Lo, *s.Variables()[a].Hi)
	fmt.Printf("b: [%d, %d]\n", *s.Variables()[b].Lo, *s.Variables()[b].Hi)
	// Output:
	// a: [3, 7]
	// b: [3, 7]
}

func ExampleLeq() {
	s := New[int64]()
	a, b := s.AddVar(), s.AddVar()
	lo, hi := int64(10), int64(5)
	s.Variables()[a].Lo, s.Variables()[a].Hi = &lo, &lo
	s.Variables()[b].Lo, s.Variables()[b].Hi = &hi, &hi
	s.AddConstraint(Leq[int64]{A: a, B: b})
	s.Propagate()
	fmt.Println(s.Variables()[a].Inconsistent, s.Variables()[b].Inconsistent)
	// Output: true true
}

func ExampleDisjunction() {
	s := New[int64]()
	zero, hundred := int64(0), int64(100)
	low, high, x := s.AddVar(), s.AddVar(), s.AddVar()
	s.Variables()[low].Lo, s.Variables()[low].Hi = &zero, &zero
	s.Variables()[high].Lo, s.Variables()[high].Hi = &hundred, &hundred
	mid := int64(50)
	s.Variables()[x].Lo, s.Variables()[x].Hi = &mid, &mid
	// x ≤ 0  OR  100 ≤ x ; neither holds for x = 50.
	s.AddConstraint(Disjunction[int64]{Alts: []Constraint[int64]{
		Leq[int64]{A: x, B: low},
		Leq[int64]{A: high, B: x},
	}})
	s.Propagate()
	fmt.Println(s.Variables()[x].Inconsistent)
	// Output: true
}

// --- Benchmark ---

// BenchmarkPropagate exercises a graph at the live-backend scale (~440
// vars, ~600 constraints) with a mix mirroring derived_window.go:
// ~2/3 Leqs for observed-edge propagation, ~1/3 Disjunctions for
// missing-edge dominated-branch pruning, and a non-chain topology so
// propagation can't collapse along a single line.
func BenchmarkPropagate(b *testing.B) {
	const nCPs = 200
	const nStations = 40
	const nObs = 270
	for i := 0; i < b.N; i++ {
		s := New[int64]()
		cpStart := make([]int, nCPs)
		cpEnd := make([]int, nCPs)
		for j := 0; j < nCPs; j++ {
			cpStart[j] = s.AddVar()
			cpEnd[j] = s.AddVar()
			s.AddConstraint(Leq[int64]{A: cpStart[j], B: cpEnd[j]})
		}
		st := make([]int, nStations)
		for j := 0; j < nStations; j++ {
			st[j] = s.AddVar()
		}
		// Two anchored stations so the worklist actually has work to do.
		vars := s.Variables()
		vars[st[0]].Lo, vars[st[0]].Hi = ip(1850), ip(1850)
		vars[st[nStations-1]].Lo, vars[st[nStations-1]].Hi = ip(1920), ip(1920)
		for j := 0; j < nObs; j++ {
			stIdx := st[j%nStations]
			cpIdx := j % nCPs
			if j%3 == 0 {
				// Disjunction (missing observation).
				s.AddConstraint(Disjunction[int64]{Alts: []Constraint[int64]{
					Leq[int64]{A: stIdx, B: cpStart[cpIdx]},
					Leq[int64]{A: cpEnd[cpIdx], B: stIdx},
				}})
			} else {
				// Observed: c.start ≤ s.t ≤ c.end (two Leqs).
				s.AddConstraint(Leq[int64]{A: cpStart[cpIdx], B: stIdx})
				s.AddConstraint(Leq[int64]{A: stIdx, B: cpEnd[cpIdx]})
			}
		}
		s.Propagate()
	}
}
