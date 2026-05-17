-- Off-diagonal east-north covariance at the converged solution, alongside
-- the existing per-axis sigma columns. With (sigma_lat, sigma_lng, cov) the
-- frontend can render a true tilted error ellipse instead of an axis-aligned
-- one. NULL ⇒ no covariance computed (entity wasn't in a successful solve,
-- or one of the two axes was locked / unobservable).
--
-- Units: m² in local ENU east-north. cov ≈ <ΔE · ΔN>; combine with the
-- existing sigmas as the 2×2 matrix [[σ_E², cov], [cov, σ_N²]].

ALTER TABLE stations
    ADD COLUMN cov_lat_lng DOUBLE PRECISION;

ALTER TABLE control_points
    ADD COLUMN cov_est_lat_lng DOUBLE PRECISION;
