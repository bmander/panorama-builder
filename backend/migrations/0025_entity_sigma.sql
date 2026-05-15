-- Per-axis standard deviation at the converged solution, computed by the
-- solver via ceres::Covariance and written back as part of the same session
-- ops as the parameter diffs. NULL ⇒ no σ data yet (entity never participated
-- in a successful solve, or the corresponding axis was locked / fully
-- unobservable so Covariance returned NaN).
--
-- Units: meters for station / control-point positions (in local ENU), radians
-- for photo angles, dimensionless for K1 / K2. Matches Result.PerEntitySigma
-- in backend/solver/types.go.

ALTER TABLE stations
    ADD COLUMN sigma_lat DOUBLE PRECISION,
    ADD COLUMN sigma_lng DOUBLE PRECISION,
    ADD COLUMN sigma_alt DOUBLE PRECISION;

ALTER TABLE photos
    ADD COLUMN sigma_photo_az   DOUBLE PRECISION,
    ADD COLUMN sigma_photo_tilt DOUBLE PRECISION,
    ADD COLUMN sigma_photo_roll DOUBLE PRECISION,
    ADD COLUMN sigma_size_rad   DOUBLE PRECISION,
    ADD COLUMN sigma_dist_k1    DOUBLE PRECISION,
    ADD COLUMN sigma_dist_k2    DOUBLE PRECISION;

ALTER TABLE control_points
    ADD COLUMN sigma_est_lat DOUBLE PRECISION,
    ADD COLUMN sigma_est_lng DOUBLE PRECISION,
    ADD COLUMN sigma_est_alt DOUBLE PRECISION;
