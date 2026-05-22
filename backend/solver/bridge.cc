//go:build !noceres

// Ceres-Solver bridge. Builds and solves a bundle-adjustment problem matching
// the math in solver/solve.go::computeOneObsResidual. Called via the C ABI in
// bridge.h from bridge_ceres.go.
//
// Parameterization: stations and control points use ENU offset blocks
// anchored to a precomputed double LLA. Per-axis CP equality (plumb / level)
// is implemented by aliasing parameter blocks via cp_axis_rep — Ceres handles
// the rest. Locks are SetParameterBlockConstant (1-D blocks) or SubsetManifold
// (the 6-vector photo block).

#include "bridge.h"
#include "cost_functor.h"

#include <ceres/ceres.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <vector>

namespace {

using ::pc::Anchor;
using ::pc::MakeAnchor;
using ::pc::ObsCost;
using ::pc::TikhonovL2Cost;

// Bound constraints installed on the photo parameter block. size_rad mirrors
// the post-solve clampSize() in Go; K1/K2 use a generous physical range that
// covers normal-lens Brown-Conrady values without letting the weakly-observed
// narrow-FOV case run off to enormous magnitudes.
constexpr double kSizeRadLo = 2.0 * 3.14159265358979323846 / 180.0;  // 2°
constexpr double kSizeRadHi = 3.14159265358979323846 * 0.95;
constexpr double kKBound    = 0.5;

// Cauchy loss scale (radians) for the angular observation residuals. Below
// this scale the loss is ~L2; well above it the influence of an outlier
// observation is smoothly attenuated. Picked so well-fit residuals
// (sub-10 mrad) are essentially L2 while a wandering iterate doesn't get
// yanked by a few catastrophically misprojected observations.
constexpr double kObsCauchyScale = 0.01;

// Exported from Go via //export pc_iter_callback in bridge_ceres.go. Returns
// 1 to abort the solve, 0 to continue. The handle round-trips an opaque Go
// table index so we never need to pass Go pointers across the FFI.
extern "C" int pc_iter_callback(uint64_t handle, int32_t iter,
                                double cost, int32_t accepted);

// IterationCallback bridge to Go. Snapshots the *last accepted* values of
// every parameter block so we can restore them on abort (Ceres leaves the
// last-attempted state in the blocks otherwise).
class GoIterationCallback : public ceres::IterationCallback {
public:
    GoIterationCallback(uint64_t handle,
                        std::vector<double*> tracked_blocks,
                        std::vector<int> tracked_sizes,
                        std::vector<double>* snapshot,
                        bool* aborted)
        : handle_(handle),
          blocks_(std::move(tracked_blocks)),
          sizes_(std::move(tracked_sizes)),
          snapshot_(snapshot),
          aborted_(aborted) {
        size_t total = 0;
        for (int n : sizes_) total += static_cast<size_t>(n);
        snapshot_->assign(total, 0.0);
        SnapshotFrom();  // initial state == iter 0 snapshot
    }

    ceres::CallbackReturnType operator()(
            const ceres::IterationSummary& summary) override {
        if (summary.step_is_successful) {
            SnapshotFrom();
        }
        const int abort = pc_iter_callback(
            handle_, summary.iteration, summary.cost,
            summary.step_is_successful ? 1 : 0);
        if (abort) {
            *aborted_ = true;
            return ceres::SOLVER_ABORT;
        }
        return ceres::SOLVER_CONTINUE;
    }

    // Restore the last accepted snapshot into the live parameter blocks.
    // Called by the bridge on abort so the writeback reflects the best
    // iterate seen.
    void RestoreSnapshot() {
        size_t off = 0;
        for (size_t i = 0; i < blocks_.size(); ++i) {
            const int n = sizes_[i];
            std::memcpy(blocks_[i], snapshot_->data() + off, n * sizeof(double));
            off += static_cast<size_t>(n);
        }
    }

private:
    void SnapshotFrom() {
        size_t off = 0;
        for (size_t i = 0; i < blocks_.size(); ++i) {
            const int n = sizes_[i];
            std::memcpy(snapshot_->data() + off, blocks_[i], n * sizeof(double));
            off += static_cast<size_t>(n);
        }
    }

    uint64_t handle_;
    std::vector<double*> blocks_;
    std::vector<int> sizes_;
    std::vector<double>* snapshot_;
    bool* aborted_;
};

int Run(const pc_problem* prob) {
    const int n_stations = prob->n_stations;
    const int n_photos   = prob->n_photos;
    const int n_cps      = prob->n_cps;
    const int n_obs      = prob->n_obs;

    // Precompute anchors with double-precision LLA→ECEF+ENU. These are
    // captured by value inside each ObsCost so they remain valid for the
    // lifetime of the Problem.
    std::vector<Anchor> station_anchor(n_stations);
    for (int i = 0; i < n_stations; ++i) {
        const double* lla = prob->station_anchor_lla + 3*i;
        station_anchor[i] = MakeAnchor(lla[0], lla[1], lla[2]);
    }
    std::vector<Anchor> cp_anchor(n_cps);
    for (int i = 0; i < n_cps; ++i) {
        const double* lla = prob->cp_anchor_lla + 3*i;
        cp_anchor[i] = MakeAnchor(lla[0], lla[1], lla[2]);
    }

    // Parameter blocks live directly in the Go-allocated buffers — Ceres
    // reads/writes them in place, which is exactly what we want for the
    // writeback. Aliasing for CP axis-classes resolves block pointers via
    // cp_axis_rep before AddResidualBlock.
    ceres::Problem::Options popts;
    popts.cost_function_ownership = ceres::TAKE_OWNERSHIP;
    popts.loss_function_ownership = ceres::TAKE_OWNERSHIP;
    popts.manifold_ownership      = ceres::TAKE_OWNERSHIP;
    ceres::Problem problem(popts);

    auto station_block = [&](int i, int axis) -> double* {
        return prob->station_offset + 3*i + axis;
    };
    auto photo_block = [&](int i) -> double* {
        return prob->photo_pose + 6*i;
    };
    auto cp_block = [&](int i, int axis) -> double* {
        const int rep = prob->cp_axis_rep[3*i + axis];
        return prob->cp_offset + 3*rep + axis;
    };

    // AddParameterBlock for every unique block we'll reference. Ceres
    // tolerates duplicate AddParameterBlock calls (same pointer + size), so
    // we add eagerly and let it dedupe.
    for (int i = 0; i < n_stations; ++i) {
        for (int axis = 0; axis < 3; ++axis) {
            problem.AddParameterBlock(station_block(i, axis), 1);
        }
    }
    for (int i = 0; i < n_photos; ++i) {
        double* pb = photo_block(i);
        // Project any out-of-bounds initial value onto the feasible interval
        // before installing the bound — Ceres errors if the initial iterate
        // violates the bound. K1/K2 in particular may carry values from a
        // prior diverged solve that fall outside [-kKBound, kKBound].
        if (pb[3] < kSizeRadLo) pb[3] = kSizeRadLo;
        if (pb[3] > kSizeRadHi) pb[3] = kSizeRadHi;
        if (pb[4] < -kKBound)   pb[4] = -kKBound;
        if (pb[4] >  kKBound)   pb[4] =  kKBound;
        if (pb[5] < -kKBound)   pb[5] = -kKBound;
        if (pb[5] >  kKBound)   pb[5] =  kKBound;
        problem.AddParameterBlock(pb, 6);
        problem.SetParameterLowerBound(pb, 3, kSizeRadLo);
        problem.SetParameterUpperBound(pb, 3, kSizeRadHi);
        problem.SetParameterLowerBound(pb, 4, -kKBound);
        problem.SetParameterUpperBound(pb, 4,  kKBound);
        problem.SetParameterLowerBound(pb, 5, -kKBound);
        problem.SetParameterUpperBound(pb, 5,  kKBound);
    }
    for (int i = 0; i < n_cps; ++i) {
        for (int axis = 0; axis < 3; ++axis) {
            problem.AddParameterBlock(cp_block(i, axis), 1);
        }
    }

    // Residuals: one ObsCost per observation, plus optional Tikhonov on
    // K1/K2 when k_reg_lambda > 0 (and the K isn't locked).
    for (int k = 0; k < n_obs; ++k) {
        const int p_idx  = prob->obs_photo_idx[k];
        const int cp_idx = prob->obs_cp_idx[k];
        const int s_idx  = prob->photo_station_idx[p_idx];
        const double u = prob->obs_uv[2*k + 0];
        const double v = prob->obs_uv[2*k + 1];
        const double aspect = prob->photo_aspect[p_idx];

        auto* functor = new ObsCost(station_anchor[s_idx], cp_anchor[cp_idx],
                                     aspect, u, v);
        auto* cost = new ceres::AutoDiffCostFunction<
            ObsCost, /*residuals=*/2,
            /*sE*/1, /*sN*/1, /*sU*/1,
            /*photo*/6,
            /*cE*/1, /*cN*/1, /*cU*/1>(functor);

        problem.AddResidualBlock(
            cost, new ceres::CauchyLoss(kObsCauchyScale),
            station_block(s_idx, /*east */0),
            station_block(s_idx, /*north*/1),
            station_block(s_idx, /*up   */2),
            photo_block(p_idx),
            cp_block(cp_idx, /*east */0),
            cp_block(cp_idx, /*north*/1),
            cp_block(cp_idx, /*up   */2));
    }

    if (prob->k_reg_lambda > 0.0) {
        const double sqrt_lambda = std::sqrt(prob->k_reg_lambda);
        for (int i = 0; i < n_photos; ++i) {
            const uint8_t* lock = prob->photo_lock + 6*i;
            if (!lock[4]) {
                auto* cost = new ceres::AutoDiffCostFunction<TikhonovL2Cost, 1, 6>(
                    new TikhonovL2Cost(sqrt_lambda, 4));
                problem.AddResidualBlock(cost, nullptr, photo_block(i));
            }
            if (!lock[5]) {
                auto* cost = new ceres::AutoDiffCostFunction<TikhonovL2Cost, 1, 6>(
                    new TikhonovL2Cost(sqrt_lambda, 5));
                problem.AddResidualBlock(cost, nullptr, photo_block(i));
            }
        }
    }

    // Pulls each unlocked station's ENU offset toward 0 (the user-supplied
    // lat/lng/alt). Locked axes are already constant so the residual would be
    // a no-op constant — skip.
    if (prob->position_reg_lambda > 0.0) {
        const double sqrt_lambda = std::sqrt(prob->position_reg_lambda);
        for (int i = 0; i < n_stations; ++i) {
            const uint8_t* lock = prob->station_lock + 3*i;
            for (int axis = 0; axis < 3; ++axis) {
                if (lock[axis]) continue;
                auto* cost = new ceres::AutoDiffCostFunction<TikhonovL2Cost, 1, 1>(
                    new TikhonovL2Cost(sqrt_lambda, 0));
                problem.AddResidualBlock(cost, nullptr, station_block(i, axis));
            }
        }
    }

    // Locks: 1-D blocks → SetParameterBlockConstant; photo 6-vector →
    // SubsetManifold with the locked component indices.
    for (int i = 0; i < n_stations; ++i) {
        const uint8_t* lock = prob->station_lock + 3*i;
        for (int axis = 0; axis < 3; ++axis) {
            if (lock[axis]) {
                problem.SetParameterBlockConstant(station_block(i, axis));
            }
        }
    }
    for (int i = 0; i < n_cps; ++i) {
        const uint8_t* lock = prob->cp_lock + 3*i;
        for (int axis = 0; axis < 3; ++axis) {
            if (lock[axis]) {
                problem.SetParameterBlockConstant(cp_block(i, axis));
            }
        }
    }
    for (int i = 0; i < n_photos; ++i) {
        const uint8_t* lock = prob->photo_lock + 6*i;
        std::vector<int> constant;
        for (int j = 0; j < 6; ++j) {
            if (lock[j]) constant.push_back(j);
        }
        if (constant.empty()) continue;
        if (constant.size() == 6) {
            problem.SetParameterBlockConstant(photo_block(i));
            continue;
        }
        problem.SetManifold(photo_block(i),
                            new ceres::SubsetManifold(6, constant));
    }

    // Build the iteration-callback tracked-block list before solving.
    std::vector<double*> tracked;
    std::vector<int> tracked_sizes;
    tracked.reserve(n_stations*3 + n_photos + n_cps*3);
    tracked_sizes.reserve(tracked.capacity());
    for (int i = 0; i < n_stations; ++i) {
        for (int axis = 0; axis < 3; ++axis) {
            tracked.push_back(station_block(i, axis));
            tracked_sizes.push_back(1);
        }
    }
    for (int i = 0; i < n_photos; ++i) {
        tracked.push_back(photo_block(i));
        tracked_sizes.push_back(6);
    }
    // Snapshot CP blocks via their rep so aliased blocks aren't restored twice.
    for (int i = 0; i < n_cps; ++i) {
        for (int axis = 0; axis < 3; ++axis) {
            const int rep = prob->cp_axis_rep[3*i + axis];
            if (rep != i) continue;
            tracked.push_back(cp_block(i, axis));
            tracked_sizes.push_back(1);
        }
    }
    std::vector<double> snapshot;
    bool aborted = false;
    GoIterationCallback cb(prob->go_ctx_handle, std::move(tracked),
                           std::move(tracked_sizes), &snapshot, &aborted);

    ceres::Solver::Options opts;
    // SPARSE_NORMAL_CHOLESKY rather than SPARSE_SCHUR: our CP blocks are
    // split per-axis to express plumb/level equality via parameter-block
    // aliasing, which breaks the independent-set requirement Schur places
    // on the elimination group (a single observation residual references
    // three separate CP blocks E/N/U, so they're not mutually independent).
    // Sparse normal Cholesky still scales well and benefits from
    // SuiteSparse's CHOLMOD factorization. If a future refactor merges CP
    // axes into 3-D blocks (with plumb/level enforced via residual penalties
    // or Manifolds), SPARSE_SCHUR becomes available again.
    opts.linear_solver_type = ceres::SPARSE_NORMAL_CHOLESKY;
    opts.sparse_linear_algebra_library_type = ceres::SUITE_SPARSE;
    opts.trust_region_strategy_type = ceres::LEVENBERG_MARQUARDT;
    opts.max_num_iterations = prob->max_iters > 0 ? prob->max_iters : 30;
    opts.function_tolerance  = prob->function_tol  > 0 ? prob->function_tol  : 1e-6;
    opts.parameter_tolerance = prob->parameter_tol > 0 ? prob->parameter_tol : 1e-8;
    opts.update_state_every_iteration = true;
    // Enable verbose logging when PC_BRIDGE_DEBUG is set in the environment;
    // off otherwise so tests stay quiet. Cheap to leave wired.
    if (std::getenv("PC_BRIDGE_DEBUG")) {
        opts.minimizer_progress_to_stdout = true;
        opts.logging_type = ceres::PER_MINIMIZER_ITERATION;
    } else {
        opts.minimizer_progress_to_stdout = false;
        opts.logging_type = ceres::SILENT;
    }
    opts.callbacks.push_back(&cb);

    ceres::Solver::Summary summary;
    ceres::Solve(opts, &problem, &summary);

    if (std::getenv("PC_BRIDGE_DEBUG")) {
        std::fprintf(stderr, "[ceres] %s\n", summary.FullReport().c_str());
    }

    if (aborted) {
        cb.RestoreSnapshot();
    }

    *prob->out_iterations = static_cast<int32_t>(summary.iterations.size());
    *prob->out_initial_cost = summary.initial_cost;
    *prob->out_final_cost   = summary.final_cost;
    *prob->out_converged    = summary.termination_type == ceres::CONVERGENCE ? 1 : 0;
    *prob->out_aborted      = aborted ? 1 : 0;

    // Per-parameter σ from Ceres' covariance estimator. Pre-fill the output
    // arrays with NaN; downstream Go treats NaN as "unknown / unobservable".
    const double NaN = std::numeric_limits<double>::quiet_NaN();
    for (int i = 0; i < n_stations * 3; ++i) prob->out_station_sigma[i] = NaN;
    for (int i = 0; i < n_photos * 6;   ++i) prob->out_photo_sigma[i]   = NaN;
    for (int i = 0; i < n_cps * 3;      ++i) prob->out_cp_sigma[i]      = NaN;
    for (int i = 0; i < n_stations;     ++i) prob->out_station_cov_lat_lng[i] = NaN;
    for (int i = 0; i < n_cps;          ++i) prob->out_cp_cov_lat_lng[i]      = NaN;
    *prob->out_sigma_ok = 0;

    // Skip covariance when the solve clearly didn't reach a meaningful state.
    // (Aborted runs leave the snapshot in place but the Jacobian still
    // reflects the final state; for ABORT we still attempt covariance so the
    // caller gets per-axis observability for whatever fit was reached.)
    if (summary.termination_type != ceres::FAILURE) {
        ceres::Covariance::Options cov_opts;
        // DENSE_SVD is the slowest but is the one option that copes with
        // rank-deficient Hessians by reporting NaN for unobservable axes
        // instead of erroring outright. For this app the parameter count is
        // small (≤ thousands) so cost is acceptable.
        cov_opts.algorithm_type = ceres::DENSE_SVD;
        cov_opts.null_space_rank = -1;  // automatic — drop singular directions
        ceres::Covariance covariance(cov_opts);

        // Diagonal blocks for per-axis σ, plus the (east, north) off-diagonal
        // pair per entity for the horizontal-position cov used by the map's
        // tilted error ellipse. Ceres rejects duplicate pairs outright, so
        // aliased CP blocks (plumb constraints share the east+north reps
        // across members) must be deduplicated on both the diagonal and
        // off-diagonal channels.
        std::vector<std::pair<const double*, const double*>> cov_pairs;
        cov_pairs.reserve(n_stations*4 + n_photos + n_cps*4);
        std::vector<const double*> seen;
        auto add_block = [&](const double* p) {
            for (const double* q : seen) if (q == p) return;
            seen.push_back(p);
            cov_pairs.emplace_back(p, p);
        };
        std::vector<std::pair<const double*, const double*>> seen_pairs;
        auto add_pair = [&](const double* a, const double* b) {
            for (const auto& sp : seen_pairs) {
                if (sp.first == a && sp.second == b) return;
            }
            seen_pairs.emplace_back(a, b);
            cov_pairs.emplace_back(a, b);
        };
        for (int i = 0; i < n_stations; ++i) {
            for (int axis = 0; axis < 3; ++axis) add_block(station_block(i, axis));
            add_pair(station_block(i, /*east */0),
                     station_block(i, /*north*/1));
        }
        for (int i = 0; i < n_photos; ++i) add_block(photo_block(i));
        for (int i = 0; i < n_cps; ++i) {
            for (int axis = 0; axis < 3; ++axis) add_block(cp_block(i, axis));
            add_pair(cp_block(i, /*east */0),
                     cp_block(i, /*north*/1));
        }

        // Compute() returns false on a rank deficiency it couldn't resolve.
        // Per-block extraction still works when we proceed though, so we try
        // anyway and let NaN propagate naturally for failed blocks.
        const bool cov_ok = covariance.Compute(cov_pairs, &problem);
        *prob->out_sigma_ok = cov_ok ? 1 : 0;

        // Ceres computes (JᵀJ)⁻¹ assuming residuals have unit variance. The
        // real parameter covariance is σ_r² · (JᵀJ)⁻¹ where σ_r² is the
        // estimated residual variance (2 · final_cost / (m − n)). Without
        // this scaling the raw σ values would be the Cramér-Rao bound at
        // unit noise — orders of magnitude too large for the actual residual
        // floor we converge to.
        const int m = problem.NumResiduals();
        const int n = problem.NumParameters();
        const int dof = m > n ? m - n : 1;
        const double residual_var = 2.0 * summary.final_cost / dof;
        const double residual_scale = residual_var > 0 ? std::sqrt(residual_var) : 1.0;

        // Helper: read the diagonal of a covariance block and write sqrt(σ²)
        // (scaled to the actual residual variance) into the output slot.
        auto fill_sigma = [&](const double* block, double* out, int sz) {
            std::vector<double> buf(sz * sz);
            if (!covariance.GetCovarianceBlock(block, block, buf.data())) {
                return;
            }
            for (int j = 0; j < sz; ++j) {
                const double var = buf[j * sz + j];
                if (var >= 0 && std::isfinite(var)) {
                    out[j] = std::sqrt(var) * residual_scale;
                } else {
                    out[j] = NaN;
                }
            }
        };

        // Helper: read the scalar covariance between two 1-D blocks. Same
        // residual-variance scaling as the diagonal σ², applied here as σ²
        // (residual_scale²) since cov has units of σ², not σ.
        auto fetch_cov = [&](const double* a, const double* b) -> double {
            double v = 0;
            if (!covariance.GetCovarianceBlock(a, b, &v)) return NaN;
            if (!std::isfinite(v)) return NaN;
            return v * residual_scale * residual_scale;
        };

        for (int i = 0; i < n_stations; ++i) {
            for (int axis = 0; axis < 3; ++axis) {
                fill_sigma(station_block(i, axis), prob->out_station_sigma + 3*i + axis, 1);
            }
            prob->out_station_cov_lat_lng[i] =
                fetch_cov(station_block(i, 0), station_block(i, 1));
        }
        for (int i = 0; i < n_photos; ++i) {
            fill_sigma(photo_block(i), prob->out_photo_sigma + 6*i, 6);
        }
        for (int i = 0; i < n_cps; ++i) {
            for (int axis = 0; axis < 3; ++axis) {
                // Non-rep CPs share their rep's block; reading it produces the
                // same σ — emit it on every member so the per-CP output is
                // self-contained.
                fill_sigma(cp_block(i, axis), prob->out_cp_sigma + 3*i + axis, 1);
            }
            prob->out_cp_cov_lat_lng[i] =
                fetch_cov(cp_block(i, 0), cp_block(i, 1));
        }
    }

    return 0;
}

}  // namespace

extern "C" int pc_solve(const pc_problem* prob) {
    try {
        return Run(prob);
    } catch (const std::exception&) {
        return 1;
    } catch (...) {
        return 2;
    }
}
