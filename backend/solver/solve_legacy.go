//go:build go_solver_gn

// Legacy Gauss-Newton + Levenberg-Marquardt solver. Selected via the
// `go_solver_gn` build tag (`go build -tags go_solver_gn`); the default
// build uses the Ceres bridge in solve.go. Kept for A/B benchmarking and
// as a fallback for environments without Ceres-Solver installed.
//
// Shared scaffolding lives in context.go; only the dense Jacobian +
// normal-equations machinery and the outer GN loop live here.
package solver

import (
	"fmt"
	"math"

	"gonum.org/v1/gonum/mat"
)

const (
	rankDefRel    = 1e-9 // column-norm threshold (relative to max) to flag a free param as unobservable
	lmRel         = 1e-6 // relative LM damping: λ = lmRel * max(diag(JᵀJ))
	maxBacktracks = 5
)

// gnState extends solveContext with GN-loop-specific scratch buffers. Kept
// off the shared solveContext so the Ceres path doesn't allocate a dense
// m×n Jacobian for big problems.
type gnState struct {
	*solveContext

	// Sparsity index: slotObs[k] = obs indices whose 2-row block depends on
	// slot k; slotRegRow[k] = the slot's Tikhonov row (or -1). Built once in
	// buildJacobianSparsity and constant for the rest of the solve, which is
	// what lets jacobian() reuse a single mat.Dense across iterations without
	// re-zeroing — every cell we don't write here, we never write.
	slotObs    [][]int
	slotRegRow []int

	// Per-iteration scratch reused across the GN loop so the inner loop
	// allocates nothing. rBuf holds the accepted residual vector; the
	// line-search swaps it with rTrialBuf on accept so the previously
	// accepted vector stays valid during trial evaluation.
	rBuf      []float64
	rTrialBuf []float64
	jacMat    *mat.Dense // m × n; cells outside slotObs[k]∪{slotRegRow[k]} stay at zero forever
	colBuf    []float64  // n*m; live-column snapshot for solveNormalEquations
	colSlices [][]float64
}

// Solve runs Gauss-Newton with Levenberg-Marquardt damping over the in-scope
// observations and free parameters of the given problem.
//
// Returns Result with the diff (Changes) the caller should write back inside
// a single transaction. On Diverged the diff is empty — the caller writes
// nothing. Errors are reserved for problem-build failures (gauge, missing
// focus); a failed iteration is reported via Diverged, not error.
func Solve(problem Problem, cfg Config) (Result, error) {
	cfg = cfg.withDefaults()

	c, err := buildContext(problem, cfg)
	if err != nil {
		return Result{}, err
	}

	if len(c.obs) == 0 || len(c.slots) == 0 {
		// Nothing to solve, but not an error. Still pass through composeChanges
		// so a locked-axis class that snapped a member during reconciliation
		// surfaces as a writeback diff.
		state := c.readState()
		return Result{
			Converged:         true,
			AutoLockedColumns: c.autoLocked,
			Changes:           c.composeChanges(state, state),
		}, nil
	}

	g := &gnState{solveContext: c}
	g.buildJacobianSparsity()

	state := c.readState()
	initialState := append([]float64(nil), state...)

	g.rBuf = c.computeResidualsInto(g.rBuf)
	r := g.rBuf
	initialNorm := norm(r)
	prevNorm := initialNorm
	bestState := append([]float64(nil), state...)
	bestNorm := initialNorm

	converged := false
	nonImprove := 0
	smallImprove := 0
	iters := 0

	for ; iters < cfg.MaxIters; iters++ {
		// External stop signal (Cancel / Stop here from the SSE handler).
		if cfg.ShouldStop != nil && cfg.ShouldStop() {
			break
		}
		// Convergence by residual.
		if prevNorm < cfg.ResidualTolRad*math.Sqrt(float64(len(r))) {
			converged = true
			break
		}

		J := g.jacobian()

		// Detect rank-deficient columns and exclude from the linear system.
		live := g.detectLiveColumns(J)
		if len(live) == 0 {
			break
		}

		dx, ok := g.solveNormalEquations(J, r, live)
		if !ok {
			break
		}

		// Backtracking line search. Reuse the trial state and trial residual
		// buffers across attempts and iterations to avoid alloc churn.
		oldNorm := prevNorm
		alpha := 1.0
		accepted := false
		var stepNorm float64
		if cap(g.rTrialBuf) < c.residualSize() {
			g.rTrialBuf = make([]float64, c.residualSize())
		}
		trial := make([]float64, len(state))
		for attempt := 0; attempt < maxBacktracks; attempt++ {
			for k := range state {
				trial[k] = state[k] + alpha*dx[k]
			}
			c.applyState(trial)
			g.rTrialBuf = c.computeResidualsInto(g.rTrialBuf)
			rTrial := g.rTrialBuf
			normTrial := norm(rTrial)
			if !math.IsNaN(normTrial) && !math.IsInf(normTrial, 0) && normTrial < prevNorm {
				// Re-read state in case clamping (size_rad) shrunk the step.
				state = c.readState()
				stepSq := 0.0
				for k := range dx {
					stepSq += (alpha * dx[k]) * (alpha * dx[k])
				}
				stepNorm = math.Sqrt(stepSq)
				// Swap r and rTrialBuf so subsequent iterations see the
				// accepted residual via rBuf and a fresh scratch lives in
				// rTrialBuf.
				g.rBuf, g.rTrialBuf = rTrial, g.rBuf
				r = g.rBuf
				prevNorm = normTrial
				accepted = true
				break
			}
			alpha *= 0.5
		}

		if cfg.OnIteration != nil {
			cfg.OnIteration(iters, rms(prevNorm, len(r)), accepted)
		}

		if !accepted {
			// Restore best-known good state and count a non-improvement.
			c.applyState(state)
			nonImprove++
			if nonImprove >= cfg.DivergenceWindow {
				break
			}
			continue
		}
		nonImprove = 0

		if prevNorm < bestNorm {
			bestNorm = prevNorm
			bestState = append(bestState[:0], state...)
		}

		if stepNorm < cfg.StepTol {
			converged = true
			break
		}

		// Relative-improvement plateau: if the residual norm shrunk by less
		// than RelImproveTol for the last RelImproveWindow accepted iters,
		// declare convergence. Catches the noise-floor plateau where the
		// absolute ResidualTolRad will never be reached.
		var relImprove float64
		if oldNorm > 0 {
			relImprove = (oldNorm - prevNorm) / oldNorm
		}
		if relImprove < cfg.RelImproveTol {
			smallImprove++
			if smallImprove >= cfg.RelImproveWindow {
				converged = true
				break
			}
		} else {
			smallImprove = 0
		}
	}

	// Always end with the best iterate applied; that's what the diff is built from.
	c.applyState(bestState)

	diverged := bestNorm >= initialNorm
	var changes []EntityChange
	if !diverged {
		changes = c.composeChanges(initialState, bestState)
	}

	return Result{
		Iterations:         iters,
		InitialResidualRMS: rms(initialNorm, len(r)),
		FinalResidualRMS:   rms(bestNorm, len(r)),
		Converged:          converged && !diverged,
		Diverged:           diverged,
		AutoLockedColumns:  c.autoLocked,
		Changes:            changes,
	}, nil
}

// buildJacobianSparsity precomputes, for each slot, the residual rows it
// touches. Run once after slots and obs are finalized; the patterns are
// static for the rest of the solve.
func (g *gnState) buildJacobianSparsity() {
	c := g.solveContext

	obsByStation := make(map[string][]int, len(c.stationIdx))
	obsByPhoto := make(map[string][]int, len(c.photoIdx))
	obsByCP := make(map[string][]int, len(c.cpIdx))
	for k, o := range c.obs {
		stID := c.problem.Photos[c.obsPhotoIdx[k]].StationID
		obsByPhoto[o.PhotoID] = append(obsByPhoto[o.PhotoID], k)
		obsByCP[o.ControlPointID] = append(obsByCP[o.ControlPointID], k)
		obsByStation[stID] = append(obsByStation[stID], k)
	}

	g.slotObs = make([][]int, len(c.slots))
	g.slotRegRow = make([]int, len(c.slots))
	regRow := 2 * len(c.obs)
	for k, s := range c.slots {
		switch s.kind {
		case "station":
			g.slotObs[k] = obsByStation[s.id]
		case "photo":
			g.slotObs[k] = obsByPhoto[s.id]
		case "control_point":
			// A CP slot writes every class member on its axis, so its
			// jacobian column must cover the obs of every member.
			if len(s.cpMembers) <= 1 {
				g.slotObs[k] = obsByCP[s.id]
			} else {
				var combined []int
				for _, idx := range s.cpMembers {
					combined = append(combined, obsByCP[c.problem.ControlPoints[idx].ID]...)
				}
				g.slotObs[k] = combined
			}
		}
		if s.regWeight > 0 {
			g.slotRegRow[k] = regRow
			regRow++
		} else {
			g.slotRegRow[k] = -1
		}
	}

	m := c.residualSize()
	n := len(c.slots)
	if m > 0 && n > 0 {
		g.jacMat = mat.NewDense(m, n, nil)
		g.colBuf = make([]float64, n*m)
		g.colSlices = make([][]float64, n)
	}
}

// jacobian builds the m×n finite-difference Jacobian using central
// differences. Sparsity makes this cheap: each slot only touches the rows
// listed in slotObs[k] (plus its own reg row, if any), so untouched cells
// in g.jacMat stay at the zero they were initialized to in
// buildJacobianSparsity — that is the invariant that makes the
// per-iteration reuse safe.
func (g *gnState) jacobian() *mat.Dense {
	c := g.solveContext
	J := g.jacMat
	raw := J.RawMatrix()
	data := raw.Data
	stride := raw.Stride

	for k := range c.slots {
		affected := g.slotObs[k]
		regRow := g.slotRegRow[k]
		regWeight := c.slots[k].regWeight
		eps := c.slots[k].scale
		inv2eps := 1.0 / (2 * eps)
		orig := c.readSlot(k)

		c.writeSlot(k, orig+eps)
		for _, obsIdx := range affected {
			az, el := c.computeOneObsResidual(obsIdx)
			data[(2*obsIdx)*stride+k] = az
			data[(2*obsIdx+1)*stride+k] = el
		}

		c.writeSlot(k, orig-eps)
		for _, obsIdx := range affected {
			az, el := c.computeOneObsResidual(obsIdx)
			i0 := (2*obsIdx)*stride + k
			i1 := (2*obsIdx+1)*stride + k
			data[i0] = (data[i0] - az) * inv2eps
			data[i1] = (data[i1] - el) * inv2eps
		}
		// Reg-row derivative is exact: r_reg = regWeight·param ⇒ ∂/∂param =
		// regWeight. Reg slots (k1/k2) aren't subject to clampSize, so the FD
		// column is identically the analytic value.
		if regRow >= 0 {
			data[regRow*stride+k] = regWeight
		}

		c.writeSlot(k, orig)
	}
	return J
}

// detectLiveColumns returns the indices of slots whose Jacobian column carries
// real signal (L2 norm ≥ rankDefRel · max-column-norm). Columns below the
// threshold are pinned for this run and recorded in c.autoLocked.
func (g *gnState) detectLiveColumns(J *mat.Dense) []int {
	c := g.solveContext
	m, n := J.Dims()
	if n == 0 {
		return nil
	}
	raw := J.RawMatrix()
	data, stride := raw.Data, raw.Stride
	norms := make([]float64, n)
	maxNorm := 0.0
	for k := 0; k < n; k++ {
		s := 0.0
		for i := 0; i < m; i++ {
			v := data[i*stride+k]
			s += v * v
		}
		norms[k] = math.Sqrt(s)
		if norms[k] > maxNorm {
			maxNorm = norms[k]
		}
	}
	threshold := maxNorm * rankDefRel
	var live []int
	for k := 0; k < n; k++ {
		if norms[k] < threshold {
			tag := fmt.Sprintf("%s:%s:%s", c.slots[k].kind, c.slots[k].id, c.slots[k].name)
			if !contains(c.autoLocked, tag) {
				c.autoLocked = append(c.autoLocked, tag)
			}
			continue
		}
		live = append(live, k)
	}
	return live
}

// solveNormalEquations forms (JᵀJ + λI) Δx = −Jᵀr on the live subset and
// returns Δx in the full slot space (zeros on dropped columns). Snapshots
// each live column into a contiguous slice (reusing g.colBuf / g.colSlices
// across iterations) so the JᵀJ accumulation is a flat dot product rather
// than nn²/2 mat.Col allocations.
func (g *gnState) solveNormalEquations(J *mat.Dense, r []float64, live []int) ([]float64, bool) {
	c := g.solveContext
	nn := len(live)
	if nn == 0 {
		return nil, false
	}
	m, _ := J.Dims()
	raw := J.RawMatrix()
	data, stride := raw.Data, raw.Stride

	cols := g.colSlices[:nn]
	for a, ka := range live {
		col := g.colBuf[a*m : (a+1)*m]
		for i := 0; i < m; i++ {
			col[i] = data[i*stride+ka]
		}
		cols[a] = col
	}

	JtJ := mat.NewDense(nn, nn, nil)
	Jtr := mat.NewVecDense(nn, nil)

	for a := 0; a < nn; a++ {
		colA := cols[a]
		for b := a; b < nn; b++ {
			colB := cols[b]
			s := 0.0
			for i := 0; i < m; i++ {
				s += colA[i] * colB[i]
			}
			JtJ.Set(a, b, s)
			if a != b {
				JtJ.Set(b, a, s)
			}
		}
		s := 0.0
		for i := 0; i < m; i++ {
			s += colA[i] * r[i]
		}
		Jtr.SetVec(a, -s)
	}

	maxDiag := 0.0
	for a := 0; a < nn; a++ {
		if v := JtJ.At(a, a); v > maxDiag {
			maxDiag = v
		}
	}
	lambda := lmRel * maxDiag
	if lambda == 0 {
		lambda = lmRel
	}
	for a := 0; a < nn; a++ {
		JtJ.Set(a, a, JtJ.At(a, a)+lambda)
	}

	var dxLive mat.VecDense
	if err := dxLive.SolveVec(JtJ, Jtr); err != nil {
		return nil, false
	}

	dx := make([]float64, len(c.slots))
	for a, ka := range live {
		dx[ka] = dxLive.AtVec(a)
	}
	return dx, true
}
