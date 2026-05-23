// Pure-C ABI for the Ceres-Solver bridge. Called from bridge_ceres.go via
// cgo. Pre-allocate every output buffer on the Go side; C++ writes in place.
//
// Lifetimes: all pointers passed in must remain valid for the duration of
// pc_solve(). The C++ side does no allocations on Go memory.
#ifndef PANORAMA_BRIDGE_H
#define PANORAMA_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// pc_problem is the flat FFI struct mirroring the in-scope subset of a
// solver.Problem. Indices are into the parallel arrays; out-of-scope entities
// must be omitted by the caller (we never see them).
//
// CP axis sharing: cp_axis_rep[i*3 + axis] = j means CP i's `axis`
// (0=east, 1=north, 2=up) parameter block is aliased to CP j's block on
// that axis. Self-rep means i == j. Identical to the Go union-find result.
//
// Locks: a 1 bit means the corresponding scalar is frozen (held constant);
// 0 means free.
typedef struct {
    int32_t  n_stations;
    int32_t  n_photos;
    int32_t  n_cps;
    int32_t  n_obs;

    // Anchors (lat°, lng°, alt m). C++ recomputes ECEF + ENU basis from these
    // with double precision — anchors are constants in the autodiff residual.
    const double *station_anchor_lla;   // [n_stations * 3]
    const double *cp_anchor_lla;        // [n_cps * 3]

    // Initial offset values (meters in entity's own local ENU). Usually all
    // zero on entry — kept explicit so the bridge has no hidden state.
    double *station_offset;             // [n_stations * 3]  in/out
    double *cp_offset;                  // [n_cps * 3]       in/out

    // Per-axis locks. 1 = constant, 0 = free.
    const uint8_t *station_lock;        // [n_stations * 3]
    const uint8_t *cp_lock;             // [n_cps * 3]

    // Photo pose: (az, tilt, roll, sizeRad, K1, K2). photo_aspect is a
    // separate constant captured per photo (not optimized).
    double *photo_pose;                 // [n_photos * 6]    in/out
    const double *photo_aspect;         // [n_photos]
    const uint8_t *photo_lock;          // [n_photos * 6]
    const int32_t *photo_station_idx;   // [n_photos]

    // CP axis sharing (union-find rep per axis).
    const int32_t *cp_axis_rep;         // [n_cps * 3]

    // Observations.
    const int32_t *obs_photo_idx;       // [n_obs]
    const int32_t *obs_cp_idx;          // [n_obs]
    const double  *obs_uv;              // [n_obs * 2]

    // Tuning.
    double  k_reg_lambda;            // 0 disables Tikhonov on K1/K2
    double  position_reg_lambda;     // 0 disables station-offset prior
    int32_t max_iters;
    double  function_tol;       // maps to options.function_tolerance
    double  parameter_tol;      // maps to options.parameter_tolerance

    // Diagnostics (written by C++).
    int32_t *out_iterations;
    double  *out_initial_cost;  // 0.5 * ||r_initial||²
    double  *out_final_cost;    // 0.5 * ||r_final||²
    int32_t *out_converged;     // 1 if Ceres reported CONVERGENCE
    int32_t *out_aborted;       // 1 if cancel callback fired

    // Per-parameter standard deviation at the converged solution. C++ computes
    // these via ceres::Covariance (DENSE_SVD, robust to rank deficiency).
    // Same layout as the corresponding *_offset / *_pose buffers. NaN means
    // the axis's covariance could not be determined (locked, or fully
    // unobservable). All-NaN output is the signal that covariance computation
    // failed entirely (e.g. solver diverged); caller treats as "no σ data".
    double *out_station_sigma;       // [n_stations * 3]   (meters in local ENU)
    double *out_photo_sigma;         // [n_photos * 6]     (radians for angles, unitless for K1/K2)
    double *out_cp_sigma;            // [n_cps * 3]        (meters in local ENU)
    // Off-diagonal east-north covariance per entity, m². NaN when either
    // axis is locked / unobservable. With the two diagonal σ values these
    // give the full 2×2 horizontal-position covariance for drawing tilted
    // error ellipses.
    double *out_station_cov_lat_lng; // [n_stations]
    double *out_cp_cov_lat_lng;      // [n_cps]
    int32_t *out_sigma_ok;           // 1 if covariance was computed; 0 means all NaN

    // Iteration-callback context: opaque to C++, passed back through to
    // pc_iter_callback verbatim. The Go side allocates a uint64 handle into
    // its own context table and stashes it here.
    uint64_t go_ctx_handle;
} pc_problem;

// Run the solve. Returns 0 on success, nonzero on a build/solve failure
// (e.g. C++ exception). On nonzero return the output arrays may be partially
// written; the Go side discards them.
int pc_solve(const pc_problem *prob);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // PANORAMA_BRIDGE_H
