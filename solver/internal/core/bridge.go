package core

// #cgo CXXFLAGS: -std=c++17 -O2 -DGLOG_USE_GLOG_EXPORT
// #cgo darwin CXXFLAGS: -I/usr/local/include -I/usr/local/include/eigen3 -I/opt/homebrew/include -I/opt/homebrew/include/eigen3
// #cgo linux  CXXFLAGS: -I/usr/include/eigen3
// #cgo darwin LDFLAGS: -L/usr/local/lib -L/opt/homebrew/lib -lceres -lglog
// #cgo linux  LDFLAGS: -lceres -lglog
// #include "bridge.h"
import "C"

import (
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/bmander/panorama-builder/shared/wire"
)

// bridgeCtx is the Go side of the iteration-callback handle. The C++ bridge
// stores only a uint64 handle in pc_problem.go_ctx_handle and passes it back
// through pc_iter_callback; we resolve it to this struct here. This keeps
// Go pointers out of the cgo boundary (passing Go pointers that contain
// other Go pointers is forbidden by cgo's pointer rules).
type bridgeCtx struct {
	cfg          Config
	residualSize int
}

var (
	ctxMu       sync.Mutex
	ctxNextID   atomic.Uint64
	ctxRegistry = map[uint64]*bridgeCtx{}
)

func registerCtx(c *bridgeCtx) uint64 {
	id := ctxNextID.Add(1)
	ctxMu.Lock()
	ctxRegistry[id] = c
	ctxMu.Unlock()
	return id
}

func releaseCtx(id uint64) {
	ctxMu.Lock()
	delete(ctxRegistry, id)
	ctxMu.Unlock()
}

func lookupCtx(id uint64) *bridgeCtx {
	ctxMu.Lock()
	c := ctxRegistry[id]
	ctxMu.Unlock()
	return c
}

//export pc_iter_callback
func pc_iter_callback(handle C.uint64_t, iter C.int32_t, cost C.double, accepted C.int32_t) C.int {
	ctx := lookupCtx(uint64(handle))
	if ctx == nil {
		return 0
	}
	if ctx.cfg.OnIteration != nil && ctx.residualSize > 0 {
		// Ceres reports summary.cost = 0.5·||r||². Convert to RMS over all
		// residual rows so the SSE stream emits comparable numbers to the
		// legacy Gauss-Newton path.
		rms := math.Sqrt(2 * float64(cost) / float64(ctx.residualSize))
		ctx.cfg.OnIteration(int(iter), rms, accepted != 0)
	}
	if ctx.cfg.ShouldStop != nil && ctx.cfg.ShouldStop() {
		return 1
	}
	return 0
}

// solveBridge runs the Ceres solver on the prepared solveContext and returns
// a populated wire.Result. Mutates c.stationOffset / c.photoPose / c.cpOffset in
// place with the final optimized values.
//
// Marshaling is straightforward because solveContext already holds everything
// in the right shape — we just point cgo at the underlying memory. Anchors
// are passed as the post-reconciliation cpOriginLLA / stationOriginLLA so the
// C++ side recomputes ECEF + ENU basis (matching solveContext.cpOriginECEF /
// stationOriginECEF bit-exactly).
func solveBridge(c *solveContext) (wire.Result, error) {
	nStations := len(c.problem.Stations)
	nPhotos := len(c.problem.Photos)
	nCPs := len(c.problem.ControlPoints)
	nObs := len(c.obs)

	if nObs == 0 {
		state := c.readState()
		return wire.Result{
			Converged: true,
			Changes:   c.composeChanges(state, state),
		}, nil
	}

	// Anchors as LLA. C++ recomputes ECEF/basis to exactly match the Go
	// side's currentECEF math when offsets are nonzero on return.
	stationAnchorLLA := make([]float64, nStations*3)
	for i := range c.problem.Stations {
		stationAnchorLLA[3*i+0] = c.stationOriginLLA[i][0]
		stationAnchorLLA[3*i+1] = c.stationOriginLLA[i][1]
		stationAnchorLLA[3*i+2] = c.stationOriginLLA[i][2]
	}
	cpAnchorLLA := make([]float64, nCPs*3)
	for i := range c.problem.ControlPoints {
		cpAnchorLLA[3*i+0] = c.cpOriginLLA[i][0]
		cpAnchorLLA[3*i+1] = c.cpOriginLLA[i][1]
		cpAnchorLLA[3*i+2] = c.cpOriginLLA[i][2]
	}

	// Offsets — the actual optimized variables. C-layout: [E, N, U] per
	// entity. solveContext stores them as [3]float64 with indices
	// {axisEast=0, axisNorth=1, axisUp=2} — already matches our layout.
	stationOffset := make([]float64, nStations*3)
	for i := range c.stationOffset {
		stationOffset[3*i+0] = c.stationOffset[i][axisEast]
		stationOffset[3*i+1] = c.stationOffset[i][axisNorth]
		stationOffset[3*i+2] = c.stationOffset[i][axisUp]
	}
	cpOffset := make([]float64, nCPs*3)
	for i := range c.cpOffset {
		cpOffset[3*i+0] = c.cpOffset[i][axisEast]
		cpOffset[3*i+1] = c.cpOffset[i][axisNorth]
		cpOffset[3*i+2] = c.cpOffset[i][axisUp]
	}

	// wire.Photo pose: (az, tilt, roll, sizeRad, K1, K2).
	photoPose := make([]float64, nPhotos*6)
	photoAspect := make([]float64, nPhotos)
	photoStationIdx := make([]int32, nPhotos)
	photoLock := make([]uint8, nPhotos*6)
	for i, p := range c.problem.Photos {
		photoPose[6*i+0] = c.photoPose[i].PhotoAz
		photoPose[6*i+1] = c.photoPose[i].PhotoTilt
		photoPose[6*i+2] = c.photoPose[i].PhotoRoll
		photoPose[6*i+3] = c.photoPose[i].SizeRad
		photoPose[6*i+4] = c.photoPose[i].K1
		photoPose[6*i+5] = c.photoPose[i].K2
		photoAspect[i] = c.photoPose[i].Aspect
		photoStationIdx[i] = int32(c.stationIdx[p.StationID])
		// In scoped modes (single-station / single-cp), photos outside the
		// focus group must be fully locked so Ceres treats them as constant.
		locks := c.scopedPhotoLocks(p)
		if locks.PhotoAz {
			photoLock[6*i+0] = 1
		}
		if locks.PhotoTilt {
			photoLock[6*i+1] = 1
		}
		if locks.PhotoRoll {
			photoLock[6*i+2] = 1
		}
		if locks.SizeRad {
			photoLock[6*i+3] = 1
		}
		if locks.K1 {
			photoLock[6*i+4] = 1
		}
		if locks.K2 {
			photoLock[6*i+5] = 1
		}
	}

	// Locks for stations: the FFI sees the *per-axis* lock state. In the
	// scoped modes (single-station / single-cp) every entity outside the
	// focus group must be locked on every axis so Ceres treats it as
	// constant. scopedAxisLock encapsulates that.
	stationLock := make([]uint8, nStations*3)
	for i, s := range c.problem.Stations {
		eL, nL, uL := c.scopedStationLocks(s)
		if eL {
			stationLock[3*i+0] = 1
		}
		if nL {
			stationLock[3*i+1] = 1
		}
		if uL {
			stationLock[3*i+2] = 1
		}
	}

	// CP locks: per-axis. A class is locked when any member has the axis
	// lock; reuse classAxisLock via the rep. Out-of-scope CPs (single-cp
	// mode) are fully locked.
	cpLock := make([]uint8, nCPs*3)
	cpAxisRep := make([]int32, nCPs*3)
	for i, cp := range c.problem.ControlPoints {
		for axis := 0; axis < 3; axis++ {
			repID := c.cpAxisRep[axis][cp.ID]
			cpAxisRep[3*i+axis] = int32(c.cpIdx[repID])
			locked, _ := c.classAxisLock(axis, repID)
			if locked || c.scopedCPFullyLocked(cp) {
				cpLock[3*i+axis] = 1
			}
		}
	}

	// Observations: scoped (c.obs). Indices are into the FULL problem arrays
	// — solveContext.obsPhotoIdx and obsCPIdx were built that way already.
	obsPhotoIdx := make([]int32, nObs)
	obsCPIdx := make([]int32, nObs)
	obsUV := make([]float64, nObs*2)
	for k := range c.obs {
		obsPhotoIdx[k] = int32(c.obsPhotoIdx[k])
		obsCPIdx[k] = int32(c.obsCPIdx[k])
		obsUV[2*k+0] = c.obs[k].U
		obsUV[2*k+1] = c.obs[k].V
	}

	// Set up callback context. residualSize matches solveContext.residualSize()
	// — 2·n_obs + reg rows. (Ceres includes the reg rows in summary.cost too.)
	regRows := 0
	if c.cfg.KRegLambda > 0 {
		for _, p := range c.problem.Photos {
			if !p.Locks.K1 {
				regRows++
			}
			if !p.Locks.K2 {
				regRows++
			}
		}
	}
	if c.cfg.PositionRegLambda > 0 {
		for _, st := range c.problem.Stations {
			eL, nL, uL := c.scopedStationLocks(st)
			if !eL {
				regRows++
			}
			if !nL {
				regRows++
			}
			if !uL {
				regRows++
			}
		}
	}
	ctxID := registerCtx(&bridgeCtx{cfg: c.cfg, residualSize: 2*nObs + regRows})
	defer releaseCtx(ctxID)

	// Diagnostics outputs.
	var (
		outIters     int32
		outInitCost  float64
		outFinalCost float64
		outConverged int32
		outAborted   int32
		outSigmaOK   int32
	)
	// Per-parameter σ output buffers; layout matches the input offset/pose
	// arrays. C++ pre-fills with NaN, then overwrites observable axes.
	stationSigma := make([]float64, nStations*3)
	photoSigma := make([]float64, nPhotos*6)
	cpSigma := make([]float64, nCPs*3)
	stationCovLatLng := make([]float64, nStations)
	cpCovLatLng := make([]float64, nCPs)

	// cgo's pointer rule forbids passing a Go pointer to C if the memory it
	// points to contains other Go pointers. pc_problem is itself a value type
	// allocated below (cgo allows passing &local), but every field is a
	// pointer into a Go slice — so we pin them all so the cgo runtime check
	// (cgocheck) doesn't fault. Pinned memory stays at a fixed address until
	// the pinner is unpinned at function exit.
	var pinner runtime.Pinner
	defer pinner.Unpin()
	pinSlice := func(b unsafe.Pointer) {
		if b != nil {
			pinner.Pin(b)
		}
	}
	pinSlice(unsafe.Pointer(floatPtr(stationAnchorLLA)))
	pinSlice(unsafe.Pointer(floatPtr(cpAnchorLLA)))
	pinSlice(unsafe.Pointer(floatPtr(stationOffset)))
	pinSlice(unsafe.Pointer(floatPtr(cpOffset)))
	pinSlice(unsafe.Pointer(u8Ptr(stationLock)))
	pinSlice(unsafe.Pointer(u8Ptr(cpLock)))
	pinSlice(unsafe.Pointer(floatPtr(photoPose)))
	pinSlice(unsafe.Pointer(floatPtr(photoAspect)))
	pinSlice(unsafe.Pointer(u8Ptr(photoLock)))
	pinSlice(unsafe.Pointer(i32Ptr(photoStationIdx)))
	pinSlice(unsafe.Pointer(i32Ptr(cpAxisRep)))
	pinSlice(unsafe.Pointer(i32Ptr(obsPhotoIdx)))
	pinSlice(unsafe.Pointer(i32Ptr(obsCPIdx)))
	pinSlice(unsafe.Pointer(floatPtr(obsUV)))
	pinSlice(unsafe.Pointer(floatPtr(stationSigma)))
	pinSlice(unsafe.Pointer(floatPtr(photoSigma)))
	pinSlice(unsafe.Pointer(floatPtr(cpSigma)))
	pinSlice(unsafe.Pointer(floatPtr(stationCovLatLng)))
	pinSlice(unsafe.Pointer(floatPtr(cpCovLatLng)))
	pinner.Pin(&outIters)
	pinner.Pin(&outInitCost)
	pinner.Pin(&outFinalCost)
	pinner.Pin(&outConverged)
	pinner.Pin(&outAborted)
	pinner.Pin(&outSigmaOK)

	cprob := C.pc_problem{
		n_stations:              C.int32_t(nStations),
		n_photos:                C.int32_t(nPhotos),
		n_cps:                   C.int32_t(nCPs),
		n_obs:                   C.int32_t(nObs),
		station_anchor_lla:      floatPtr(stationAnchorLLA),
		cp_anchor_lla:           floatPtr(cpAnchorLLA),
		station_offset:          floatPtr(stationOffset),
		cp_offset:               floatPtr(cpOffset),
		station_lock:            u8Ptr(stationLock),
		cp_lock:                 u8Ptr(cpLock),
		photo_pose:              floatPtr(photoPose),
		photo_aspect:            floatPtr(photoAspect),
		photo_lock:              u8Ptr(photoLock),
		photo_station_idx:       i32Ptr(photoStationIdx),
		cp_axis_rep:             i32Ptr(cpAxisRep),
		obs_photo_idx:           i32Ptr(obsPhotoIdx),
		obs_cp_idx:              i32Ptr(obsCPIdx),
		obs_uv:                  floatPtr(obsUV),
		k_reg_lambda:            C.double(c.cfg.KRegLambda),
		position_reg_lambda:     C.double(c.cfg.PositionRegLambda),
		max_iters:               C.int32_t(c.cfg.MaxIters),
		function_tol:            C.double(c.cfg.FunctionTol),
		parameter_tol:           C.double(c.cfg.StepTol),
		out_iterations:          (*C.int32_t)(unsafe.Pointer(&outIters)),
		out_initial_cost:        (*C.double)(unsafe.Pointer(&outInitCost)),
		out_final_cost:          (*C.double)(unsafe.Pointer(&outFinalCost)),
		out_converged:           (*C.int32_t)(unsafe.Pointer(&outConverged)),
		out_aborted:             (*C.int32_t)(unsafe.Pointer(&outAborted)),
		out_station_sigma:       floatPtr(stationSigma),
		out_photo_sigma:         floatPtr(photoSigma),
		out_cp_sigma:            floatPtr(cpSigma),
		out_station_cov_lat_lng: floatPtr(stationCovLatLng),
		out_cp_cov_lat_lng:      floatPtr(cpCovLatLng),
		out_sigma_ok:            (*C.int32_t)(unsafe.Pointer(&outSigmaOK)),
		go_ctx_handle:           C.uint64_t(ctxID),
	}

	initialState := c.readState()

	rc := C.pc_solve(&cprob)
	if rc != 0 {
		return wire.Result{}, fmt.Errorf("solver: ceres bridge failed (code %d)", int(rc))
	}

	// Write the final offsets / poses back into solveContext so composeChanges
	// can use the same scaffolding as the legacy path.
	for i := range c.stationOffset {
		c.stationOffset[i][axisEast] = stationOffset[3*i+0]
		c.stationOffset[i][axisNorth] = stationOffset[3*i+1]
		c.stationOffset[i][axisUp] = stationOffset[3*i+2]
	}
	for i := range c.cpOffset {
		// Re-broadcast aliased axes from rep to members so composeChanges'
		// per-CP afterLLA comes out consistent regardless of which entry it
		// reads. The shared block already holds the rep's value; just copy.
		for axis := 0; axis < 3; axis++ {
			rep := int(cpAxisRep[3*i+axis])
			c.cpOffset[i][axis] = cpOffset[3*rep+axis]
		}
	}
	for i := range c.photoPose {
		c.photoPose[i].PhotoAz = photoPose[6*i+0]
		c.photoPose[i].PhotoTilt = photoPose[6*i+1]
		c.photoPose[i].PhotoRoll = photoPose[6*i+2]
		c.photoPose[i].SizeRad = clampSize(photoPose[6*i+3])
		c.photoPose[i].K1 = photoPose[6*i+4]
		c.photoPose[i].K2 = photoPose[6*i+5]
	}

	finalState := c.readState()

	// Convert Ceres' 0.5·||r||² to per-row RMS to match what the SSE stream
	// emits per iteration (pc_iter_callback applies the same formula). Cost
	// includes the Tikhonov regularization rows when KRegLambda > 0, which
	// matches the legacy GN path's residualSize.
	m := float64(2*nObs + regRows)
	initialRMS := math.Sqrt(2 * outInitCost / m)
	finalRMS := math.Sqrt(2 * outFinalCost / m)

	// Tolerate floating-point noise: Ceres' LM only commits accepted steps,
	// so final_cost ≤ initial_cost in theory; epsilon guards against a
	// no-op solve where the two are bit-equal modulo ULP rounding.
	diverged := finalRMS > initialRMS+1e-12

	var changes []wire.EntityChange
	if !diverged {
		changes = c.composeChanges(initialState, finalState)
	}

	var sigma map[string]map[string]float64
	if outSigmaOK != 0 && outConverged != 0 && !diverged {
		sigma = c.buildSigmaMap(stationSigma, photoSigma, cpSigma,
			stationCovLatLng, cpCovLatLng, cpAxisRep)
		changes = c.mergeSigmaIntoChanges(changes, sigma)
	}

	return wire.Result{
		Iterations:         int(outIters),
		InitialResidualRMS: initialRMS,
		FinalResidualRMS:   finalRMS,
		Converged:          outConverged != 0 && !diverged,
		Diverged:           diverged,
		Changes:            changes,
		PerEntitySigma:     sigma,
	}, nil
}

// mergeSigmaIntoChanges folds per-entity uncertainty values into the
// journal-bound changes list. Keys are merged verbatim (buildSigmaMap emits
// them with their final column-style names, e.g. "sigma_lat", "cov_lat_lng",
// "sigma_est_alt"). Entities present in sigma but absent from changes get a
// fresh change row carrying only the uncertainty updates. The backend's
// applyChangeToX handlers recognize each of those keys and fold them into
// the row's σ / cov columns.
func (c *solveContext) mergeSigmaIntoChanges(
	changes []wire.EntityChange, sigma map[string]map[string]float64,
) []wire.EntityChange {
	byID := make(map[string]int, len(changes))
	for i, ch := range changes {
		byID[ch.Kind+":"+ch.ID] = i
	}
	kindFor := map[string]string{}
	for _, st := range c.problem.Stations {
		kindFor[st.ID] = "station"
	}
	for _, p := range c.problem.Photos {
		kindFor[p.ID] = "photo"
	}
	for _, cp := range c.problem.ControlPoints {
		kindFor[cp.ID] = "control_point"
	}
	for id, axes := range sigma {
		kind, ok := kindFor[id]
		if !ok {
			continue
		}
		idx, present := byID[kind+":"+id]
		if !present {
			changes = append(changes, wire.EntityChange{
				Kind:   kind,
				ID:     id,
				Before: map[string]float64{},
				After:  map[string]float64{},
			})
			idx = len(changes) - 1
			byID[kind+":"+id] = idx
		}
		for key, v := range axes {
			changes[idx].After[key] = v
		}
	}
	return changes
}

// buildSigmaMap converts the flat σ + cov arrays returned by the bridge into
// the per-entity map exposed on wire.Result. wire.Station and CP positions stay in
// ENU-meter units (σ in m, cov in m²) since that's what the per-axis
// residual integrates over; callers that want degrees can scale by
// 1/M_PER_DEG_LAT.
func (c *solveContext) buildSigmaMap(
	stationSigma, photoSigma, cpSigma []float64,
	stationCovLatLng, cpCovLatLng []float64,
	cpAxisRep []int32,
) map[string]map[string]float64 {
	out := map[string]map[string]float64{}
	// NaN ⇒ axis fully unobservable. |v| < ε ⇒ Ceres reports exact zero
	// for SetParameterBlockConstant blocks (and σ approaching the
	// double-precision noise floor), neither worth journaling. Using |v|
	// covers both σ (≥ 0) and cov (signed) without a second helper.
	put := func(id, key string, v float64) {
		if math.IsNaN(v) || math.Abs(v) < 1e-12 {
			return
		}
		m, ok := out[id]
		if !ok {
			m = map[string]float64{}
			out[id] = m
		}
		m[key] = v
	}
	for i, st := range c.problem.Stations {
		// wire.Station σ is in local-ENU meters: east, north, up. Map back to
		// (lng, lat, alt) by convention — east ≈ Δlng·cos(lat)·M_PER_DEG_LAT,
		// north ≈ Δlat·M_PER_DEG_LAT. We surface meters directly so the
		// caller doesn't have to round-trip.
		put(st.ID, "sigma_lng", stationSigma[3*i+axisEast])
		put(st.ID, "sigma_lat", stationSigma[3*i+axisNorth])
		put(st.ID, "sigma_alt", stationSigma[3*i+axisUp])
		put(st.ID, "cov_lat_lng", stationCovLatLng[i])
	}
	for i, p := range c.problem.Photos {
		put(p.ID, "sigma_photo_az", photoSigma[6*i+0])
		put(p.ID, "sigma_photo_tilt", photoSigma[6*i+1])
		put(p.ID, "sigma_photo_roll", photoSigma[6*i+2])
		put(p.ID, "sigma_size_rad", photoSigma[6*i+3])
		put(p.ID, "sigma_dist_k1", photoSigma[6*i+4])
		put(p.ID, "sigma_dist_k2", photoSigma[6*i+5])
	}
	for i, cp := range c.problem.ControlPoints {
		// CP σ also in local-ENU meters; same lng/lat/alt mapping as stations.
		// Aliased members share their rep's σ, so we read via cp_axis_rep to
		// avoid spurious NaN on dedup-skipped entries.
		eRep := int(cpAxisRep[3*i+axisEast])
		nRep := int(cpAxisRep[3*i+axisNorth])
		uRep := int(cpAxisRep[3*i+axisUp])
		put(cp.ID, "sigma_est_lng", cpSigma[3*eRep+axisEast])
		put(cp.ID, "sigma_est_lat", cpSigma[3*nRep+axisNorth])
		put(cp.ID, "sigma_est_alt", cpSigma[3*uRep+axisUp])
		// Reading cov off the rep mirrors the σ logic: aliased members all
		// see the same covariance because they share the underlying block.
		put(cp.ID, "cov_est_lat_lng", cpCovLatLng[int(cpAxisRep[3*i+axisEast])])
	}
	return out
}

// Typed C pointers to the first element of a Go slice. These slices hold
// only POD (float64 / int32 / uint8), so they contain no Go pointers — but
// the *slice header* lives in Go memory, so cgo still needs them pinned
// before crossing the FFI boundary. See the runtime.Pinner usage above.
func floatPtr(s []float64) *C.double {
	if len(s) == 0 {
		return nil
	}
	return (*C.double)(unsafe.Pointer(&s[0]))
}

func i32Ptr(s []int32) *C.int32_t {
	if len(s) == 0 {
		return nil
	}
	return (*C.int32_t)(unsafe.Pointer(&s[0]))
}

func u8Ptr(s []uint8) *C.uint8_t {
	if len(s) == 0 {
		return nil
	}
	return (*C.uint8_t)(unsafe.Pointer(&s[0]))
}
