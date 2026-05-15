// Per-axis σ gate at merge time. Walks every entity touched by the session
// (post-apply, inside the merge transaction) and refuses with 422 + the
// flagged axes if any free axis has σ above the per-axis refuse threshold.
// MergeRequest.allow_underdetermined bypasses the gate.
package main

import (
	"context"
	"math"

	"github.com/jackc/pgx/v5"
)

// Per-axis σ refuse thresholds. Frontend (cp-index.ts / photos-index.ts /
// stations-index.ts) renders against the matching warn thresholds; keep
// both in sync if you tune these. Defaults chosen to be loose enough that
// a well-solved problem clears them comfortably but tight enough that
// "diverged" or "wandered into the null space" results don't.
const (
	mergeSigmaPosRefuseM    = 1.0                        // station/CP lat/lng meters
	mergeSigmaAltRefuseM    = 0.5                        // station/CP alt meters
	mergeSigmaAngleRefuseRad = 2.0 * math.Pi / 180       // photo angles
)

// mergeGateCheck returns the list of σ-flagged free axes across the
// entities touched by this session (post-apply state, inside the open
// merge transaction). Empty slice ⇒ all clear.
func mergeGateCheck(ctx context.Context, tx pgx.Tx, sessionID string) ([]RankDeficientAxis, error) {
	// Collect distinct entity ids per kind from session_ops. Insert + update
	// + delete are all considered "touched"; deletes drop out of the post-
	// apply state and naturally pass.
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT entity_type, entity_id
		FROM session_ops
		WHERE session_id = $1 AND entity_type IN ('station','photo','control_point')`,
		sessionID)
	if err != nil {
		return nil, err
	}
	type ref struct{ kind, id string }
	var touched []ref
	for rows.Next() {
		var r ref
		if err := rows.Scan(&r.kind, &r.id); err != nil {
			rows.Close()
			return nil, err
		}
		touched = append(touched, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var out []RankDeficientAxis
	for _, r := range touched {
		flagged, err := flaggedAxesFor(ctx, tx, r.kind, r.id)
		if err != nil {
			return nil, err
		}
		if flagged != nil {
			out = append(out, *flagged)
		}
	}
	return out, nil
}

// checkAxis appends name to axes when the axis is free and its σ exceeds
// threshold. The mutation pattern is hidden inside flaggedAxesFor; callers
// stay readable as a flat sequence of axis checks.
func checkAxis(axes *[]string, locked bool, sig *float64, threshold float64, name string) {
	if !locked && sig != nil && *sig > threshold {
		*axes = append(*axes, name)
	}
}

const flaggedReason = "σ exceeds refuse threshold on free axes"

func flaggedAxesFor(ctx context.Context, tx pgx.Tx, kind, id string) (*RankDeficientAxis, error) {
	switch kind {
	case entityStation:
		var lockLat, lockLng, lockAlt bool
		var sigLat, sigLng, sigAlt *float64
		err := tx.QueryRow(ctx, `
			SELECT lock_lat, lock_lng, lock_alt, sigma_lat, sigma_lng, sigma_alt
			FROM stations WHERE id=$1`, id,
		).Scan(&lockLat, &lockLng, &lockAlt, &sigLat, &sigLng, &sigAlt)
		if err != nil {
			if err == pgx.ErrNoRows {
				return nil, nil // deleted by this session
			}
			return nil, err
		}
		var axes []string
		checkAxis(&axes, lockLat, sigLat, mergeSigmaPosRefuseM, "lat")
		checkAxis(&axes, lockLng, sigLng, mergeSigmaPosRefuseM, "lng")
		checkAxis(&axes, lockAlt, sigAlt, mergeSigmaAltRefuseM, "alt")
		if len(axes) == 0 {
			return nil, nil
		}
		return &RankDeficientAxis{
			Kind: RankDeficientAxisKindStation, ID: id, Axes: axes, Reason: flaggedReason,
		}, nil

	case entityPhoto:
		var lockAz, lockTilt, lockRoll, lockSize, lockK1, lockK2 bool
		var sAz, sTilt, sRoll, sSize, sK1, sK2 *float64
		err := tx.QueryRow(ctx, `
			SELECT lock_photo_az, lock_photo_tilt, lock_photo_roll, lock_size_rad,
			       lock_dist_k1, lock_dist_k2,
			       sigma_photo_az, sigma_photo_tilt, sigma_photo_roll,
			       sigma_size_rad, sigma_dist_k1, sigma_dist_k2
			FROM photos WHERE id=$1`, id,
		).Scan(&lockAz, &lockTilt, &lockRoll, &lockSize, &lockK1, &lockK2,
			&sAz, &sTilt, &sRoll, &sSize, &sK1, &sK2)
		if err != nil {
			if err == pgx.ErrNoRows {
				return nil, nil
			}
			return nil, err
		}
		var axes []string
		checkAxis(&axes, lockAz, sAz, mergeSigmaAngleRefuseRad, "photo_az")
		checkAxis(&axes, lockTilt, sTilt, mergeSigmaAngleRefuseRad, "photo_tilt")
		checkAxis(&axes, lockRoll, sRoll, mergeSigmaAngleRefuseRad, "photo_roll")
		checkAxis(&axes, lockSize, sSize, mergeSigmaAngleRefuseRad, "size_rad")
		// K1/K2 σ is dimensionless; the angle threshold is the natural
		// scale (radians per unit-radius residual ≈ angle threshold).
		checkAxis(&axes, lockK1, sK1, mergeSigmaAngleRefuseRad, "dist_k1")
		checkAxis(&axes, lockK2, sK2, mergeSigmaAngleRefuseRad, "dist_k2")
		if len(axes) == 0 {
			return nil, nil
		}
		return &RankDeficientAxis{
			Kind: RankDeficientAxisKindPhoto, ID: id, Axes: axes, Reason: flaggedReason,
		}, nil

	case entityControlPoint:
		var lockLat, lockLng, lockAlt bool
		var sigLat, sigLng, sigAlt *float64
		err := tx.QueryRow(ctx, `
			SELECT lock_est_lat, lock_est_lng, lock_est_alt,
			       sigma_est_lat, sigma_est_lng, sigma_est_alt
			FROM control_points WHERE id=$1`, id,
		).Scan(&lockLat, &lockLng, &lockAlt, &sigLat, &sigLng, &sigAlt)
		if err != nil {
			if err == pgx.ErrNoRows {
				return nil, nil
			}
			return nil, err
		}
		var axes []string
		checkAxis(&axes, lockLat, sigLat, mergeSigmaPosRefuseM, "est_lat")
		checkAxis(&axes, lockLng, sigLng, mergeSigmaPosRefuseM, "est_lng")
		checkAxis(&axes, lockAlt, sigAlt, mergeSigmaAltRefuseM, "est_alt")
		if len(axes) == 0 {
			return nil, nil
		}
		return &RankDeficientAxis{
			Kind: RankDeficientAxisKindControlPoint, ID: id, Axes: axes, Reason: flaggedReason,
		}, nil
	}
	return nil, nil
}
