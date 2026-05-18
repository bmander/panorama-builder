// Package stn is a tiny CP-style bound-propagation engine for Simple
// Temporal Networks and similar interval-narrowing problems.
//
// The engine owns a vector of interval-valued Variables and a list of
// Constraints over those variables. Propagate runs a worklist-driven
// fixed-point pass: each constraint can narrow incident variables'
// bounds; whenever a variable moves, every constraint adjacent to it
// is re-enqueued. Termination follows from monotonic narrowing — Lo
// rises, Hi falls, Inconsistent flips false→true — over a finite-height
// lattice.
//
// Two primitive constraint types ship with the package: Leq for
// straightforward A ≤ B inequalities, and Disjunction for logical-OR
// composition with dominated-branch pruning. Domain code defines its
// own Constraint types as needed and composes them through the engine.
package stn

import "cmp"

// Variable is one interval-valued unknown. Lo and Hi are pointer-nullable
// to encode "unbounded below" / "unbounded above". Inconsistent is set
// by a constraint whose narrowing detects that this variable cannot be
// jointly satisfied with its neighbors.
//
// Invariant: constraints update Lo / Hi by *pointer reassignment only*,
// never by mutating through the pointer. The engine relies on this so it
// can alias bound pointers across variables that share the same value
// without risking action-at-a-distance.
type Variable[T any] struct {
	Lo, Hi       *T
	Inconsistent bool
}

// Constraint relates a fixed set of variables.
//
//   - Variables lists the indices the constraint touches; the engine uses
//     this to build a static incidence map at AddConstraint time.
//   - Feasible reports whether the constraint can still be satisfied
//     under the current bounds. Disjunction uses this for dominated-
//     branch pruning; implementations should treat it as a pure query.
//   - Narrow tightens incident variables in place and returns the indices
//     of variables whose Lo / Hi / Inconsistent changed, so the engine
//     knows which neighbors to re-enqueue.
//
// Narrow must be monotonic: it may push Lo up, Hi down, or flip
// Inconsistent false→true, but never the reverse. Constraint
// implementations are responsible for flagging Inconsistent on the
// relevant variables when they detect a contradiction.
type Constraint[T any] interface {
	Variables() []int
	Feasible(vars []*Variable[T]) bool
	Narrow(vars []*Variable[T]) (changed []int)
}

// Solver owns variables + constraints and runs the worklist propagator.
type Solver[T any] struct {
	vars      []*Variable[T]
	cons      []Constraint[T]
	consByVar [][]int // var index → constraint indices touching it
}

// New returns an empty solver.
func New[T any]() *Solver[T] {
	return &Solver[T]{}
}

// AddVar allocates a fresh variable and returns its stable index.
func (s *Solver[T]) AddVar() int {
	s.vars = append(s.vars, &Variable[T]{})
	s.consByVar = append(s.consByVar, nil)
	return len(s.vars) - 1
}

// AddConstraint registers a constraint and updates the incidence map.
// The constraint's Variables() are read once here.
func (s *Solver[T]) AddConstraint(c Constraint[T]) {
	ci := len(s.cons)
	s.cons = append(s.cons, c)
	seen := map[int]bool{}
	for _, vi := range c.Variables() {
		if seen[vi] {
			continue
		}
		seen[vi] = true
		s.consByVar[vi] = append(s.consByVar[vi], ci)
	}
}

// Variables returns the live variable pointers in index order. Callers
// can read or seed Lo / Hi directly; the engine never reallocates the
// backing slice's elements, so pointers stay valid across subsequent
// AddVar / AddConstraint calls.
func (s *Solver[T]) Variables() []*Variable[T] {
	return s.vars
}

// Propagate runs the worklist to quiescence.
func (s *Solver[T]) Propagate() {
	worklist := make([]int, len(s.cons))
	inQueue := make([]bool, len(s.cons))
	for i := range worklist {
		worklist[i] = i
		inQueue[i] = true
	}
	for len(worklist) > 0 {
		ci := worklist[len(worklist)-1]
		worklist = worklist[:len(worklist)-1]
		inQueue[ci] = false
		changed := s.cons[ci].Narrow(s.vars)
		for _, vi := range changed {
			for _, cj := range s.consByVar[vi] {
				if cj == ci || inQueue[cj] {
					continue
				}
				worklist = append(worklist, cj)
				inQueue[cj] = true
			}
		}
	}
}

// Leq is the value-relation A ≤ B. Narrowing propagates:
//
//	A.Hi ≤ B.Hi   and   B.Lo ≥ A.Lo
//
// When A.Lo > B.Hi the constraint is infeasible and both endpoints are
// flagged Inconsistent. Self-loop (A == B) is a no-op since A ≤ A is
// always satisfied.
type Leq[T cmp.Ordered] struct {
	A, B int
}

func (l Leq[T]) Variables() []int {
	if l.A == l.B {
		return []int{l.A}
	}
	return []int{l.A, l.B}
}

func (l Leq[T]) Feasible(vars []*Variable[T]) bool {
	a, b := vars[l.A], vars[l.B]
	if a.Lo == nil || b.Hi == nil {
		return true
	}
	return *a.Lo <= *b.Hi
}

func (l Leq[T]) Narrow(vars []*Variable[T]) []int {
	if l.A == l.B {
		return nil
	}
	a, b := vars[l.A], vars[l.B]
	if !l.Feasible(vars) {
		var changed []int
		if !a.Inconsistent {
			a.Inconsistent = true
			changed = append(changed, l.A)
		}
		if !b.Inconsistent {
			b.Inconsistent = true
			changed = append(changed, l.B)
		}
		return changed
	}
	var changed []int
	if b.Hi != nil && (a.Hi == nil || *b.Hi < *a.Hi) {
		a.Hi = b.Hi
		changed = append(changed, l.A)
	}
	if a.Lo != nil && (b.Lo == nil || *b.Lo < *a.Lo) {
		b.Lo = a.Lo
		changed = append(changed, l.B)
	}
	return changed
}

// Disjunction is a logical OR of constituent constraints. On Narrow:
//
//   - Exactly one alternative feasible → commit to it (delegate Narrow).
//   - Zero feasible → flag every touched variable Inconsistent.
//   - Two or more feasible → no-op (wait for a neighbor to tighten).
//
// This implements dominated-branch pruning without case-splitting or
// backtracking, which is sound but strictly weaker than a full CP search.
type Disjunction[T any] struct {
	Alts []Constraint[T]
}

func (d Disjunction[T]) Variables() []int {
	seen := map[int]bool{}
	var out []int
	for _, alt := range d.Alts {
		for _, vi := range alt.Variables() {
			if seen[vi] {
				continue
			}
			seen[vi] = true
			out = append(out, vi)
		}
	}
	return out
}

func (d Disjunction[T]) Feasible(vars []*Variable[T]) bool {
	for _, alt := range d.Alts {
		if alt.Feasible(vars) {
			return true
		}
	}
	return false
}

func (d Disjunction[T]) Narrow(vars []*Variable[T]) []int {
	feasibleIdx := -1
	nfeasible := 0
	for i, alt := range d.Alts {
		if alt.Feasible(vars) {
			feasibleIdx = i
			nfeasible++
			if nfeasible > 1 {
				return nil
			}
		}
	}
	if nfeasible == 0 {
		var changed []int
		for _, vi := range d.Variables() {
			if !vars[vi].Inconsistent {
				vars[vi].Inconsistent = true
				changed = append(changed, vi)
			}
		}
		return changed
	}
	return d.Alts[feasibleIdx].Narrow(vars)
}
