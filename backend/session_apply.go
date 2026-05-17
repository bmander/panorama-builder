package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// session_apply.go converts JSONB-stored row snapshots back into typed
// inserts/updates against the main tables. Used during merge and revert.
//
// Each insert/update path serializes the full row (after_json from the
// session journal) so we don't lose any column. The `created_at` column
// preserved from the journal becomes the row's permanent value; the
// `updated_at` column is bumped to NOW().

func insertEntityFromJSON(ctx context.Context, tx pgx.Tx, entityType string, body []byte) error {
	switch entityType {
	case entityStation:
		var st Station
		if err := json.Unmarshal(body, &st); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO stations
			  (id, lat, lng, alt, name, lock_lat, lock_lng, lock_alt, captured_at,
			   sigma_lat, sigma_lng, sigma_alt, cov_lat_lng,
			   captured_at_lower, captured_at_upper, derivation_inconsistent,
			   created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
			        $10, $11, $12, $13,
			        $14, $15, $16,
			        $17, NOW())`,
			st.ID, st.Lat, st.Lng, st.Alt, st.Name, st.LockLat, st.LockLng, st.LockAlt, st.CapturedAt,
			st.SigmaLat, st.SigmaLng, st.SigmaAlt, st.CovLatLng,
			st.DerivedWindow.CapturedAtLower, st.DerivedWindow.CapturedAtUpper, st.DerivedWindow.Inconsistent,
			st.CreatedAt)
		return err
	case entityPhoto:
		var p Photo
		if err := json.Unmarshal(body, &p); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO photos
			  (id, station_id, blob_path, mime_type, size_bytes, aspect,
			   photo_az, photo_tilt, photo_roll, size_rad, opacity,
			   lock_photo_az, lock_photo_tilt, lock_photo_roll, lock_size_rad,
			   dist_k1, dist_k2, lock_dist_k1, lock_dist_k2,
			   sigma_photo_az, sigma_photo_tilt, sigma_photo_roll,
			   sigma_size_rad, sigma_dist_k1, sigma_dist_k2,
			   created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6,
			        $7, $8, $9, $10, $11,
			        $12, $13, $14, $15,
			        $16, $17, $18, $19,
			        $20, $21, $22, $23, $24, $25,
			        $26, NOW())`,
			p.ID, p.StationID, p.BlobPath, p.MimeType, p.SizeBytes, p.Aspect,
			p.PhotoAz, p.PhotoTilt, p.PhotoRoll, p.SizeRad, p.Opacity,
			p.LockPhotoAz, p.LockPhotoTilt, p.LockPhotoRoll, p.LockSizeRad,
			p.DistK1, p.DistK2, p.LockDistK1, p.LockDistK2,
			p.SigmaPhotoAz, p.SigmaPhotoTilt, p.SigmaPhotoRoll,
			p.SigmaSizeRad, p.SigmaDistK1, p.SigmaDistK2,
			p.CreatedAt)
		return err
	case entityImageMeasurement:
		var im ImageMeasurement
		if err := json.Unmarshal(body, &im); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO image_measurements
			  (id, photo_id, u, v, control_point_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
			im.ID, im.PhotoID, im.U, im.V, im.ControlPointID, im.CreatedAt)
		return err
	case entityControlPoint:
		var cp ControlPoint
		if err := json.Unmarshal(body, &cp); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO control_points
			  (id, description, notes, est_lat, est_lng, est_alt, started_at, ended_at,
			   lock_est_lat, lock_est_lng, lock_est_alt,
			   sigma_est_lat, sigma_est_lng, sigma_est_alt, cov_est_lat_lng,
			   started_at_lower, started_at_upper, ended_at_lower, ended_at_upper,
			   derivation_inconsistent,
			   created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
			        $9, $10, $11,
			        $12, $13, $14, $15,
			        $16, $17, $18, $19,
			        $20,
			        $21, NOW())`,
			cp.ID, cp.Description, cp.Notes, cp.EstLat, cp.EstLng, cp.EstAlt, cp.StartedAt, cp.EndedAt,
			cp.LockEstLat, cp.LockEstLng, cp.LockEstAlt,
			cp.SigmaEstLat, cp.SigmaEstLng, cp.SigmaEstAlt, cp.CovEstLatLng,
			cp.DerivedWindow.StartedAtLower, cp.DerivedWindow.StartedAtUpper,
			cp.DerivedWindow.EndedAtLower, cp.DerivedWindow.EndedAtUpper,
			cp.DerivedWindow.Inconsistent,
			cp.CreatedAt)
		return err
	case entityCPObservation:
		var o CpObservation
		if err := json.Unmarshal(body, &o); err != nil {
			return err
		}
		var reason *string
		if o.Reason != nil {
			s := string(*o.Reason)
			reason = &s
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO cp_observations
			  (id, station_id, control_point_id, status, reason, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
			o.ID, o.StationID, o.ControlPointID, string(o.Status), reason, o.CreatedAt)
		return err
	case entityCPConstraint:
		var c CPConstraint
		if err := json.Unmarshal(body, &c); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO cp_constraints (id, cp_a_id, cp_b_id, constraint_type, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, NOW())`,
			c.ID, c.CpAId, c.CpBId, c.ConstraintType, c.CreatedAt)
		return err
	case entityCPSurface:
		var v CPSurface
		if err := json.Unmarshal(body, &v); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO cp_surfaces (id, cp_1_id, cp_2_id, cp_3_id, cp_4_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
			v.ID, v.Cp1ID, v.Cp2ID, v.Cp3ID, v.Cp4ID, v.CreatedAt)
		return err
	}
	return fmt.Errorf("insert: unknown entity_type %q", entityType)
}

func updateEntityFromJSON(ctx context.Context, tx pgx.Tx, entityType, id string, body []byte) error {
	switch entityType {
	case entityStation:
		var st Station
		if err := json.Unmarshal(body, &st); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE stations SET
			  lat=$2, lng=$3, alt=$4, name=$5,
			  lock_lat=$6, lock_lng=$7, lock_alt=$8, captured_at=$9,
			  sigma_lat=$10, sigma_lng=$11, sigma_alt=$12, cov_lat_lng=$13,
			  captured_at_lower=$14, captured_at_upper=$15, derivation_inconsistent=$16,
			  updated_at=NOW()
			WHERE id=$1`,
			id, st.Lat, st.Lng, st.Alt, st.Name,
			st.LockLat, st.LockLng, st.LockAlt, st.CapturedAt,
			st.SigmaLat, st.SigmaLng, st.SigmaAlt, st.CovLatLng,
			st.DerivedWindow.CapturedAtLower, st.DerivedWindow.CapturedAtUpper, st.DerivedWindow.Inconsistent)
		return err
	case entityPhoto:
		var p Photo
		if err := json.Unmarshal(body, &p); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE photos SET
			  station_id=$2, blob_path=$3, mime_type=$4, size_bytes=$5, aspect=$6,
			  photo_az=$7, photo_tilt=$8, photo_roll=$9, size_rad=$10, opacity=$11,
			  lock_photo_az=$12, lock_photo_tilt=$13, lock_photo_roll=$14, lock_size_rad=$15,
			  dist_k1=$16, dist_k2=$17, lock_dist_k1=$18, lock_dist_k2=$19,
			  sigma_photo_az=$20, sigma_photo_tilt=$21, sigma_photo_roll=$22,
			  sigma_size_rad=$23, sigma_dist_k1=$24, sigma_dist_k2=$25,
			  updated_at=NOW()
			WHERE id=$1`,
			id, p.StationID, p.BlobPath, p.MimeType, p.SizeBytes, p.Aspect,
			p.PhotoAz, p.PhotoTilt, p.PhotoRoll, p.SizeRad, p.Opacity,
			p.LockPhotoAz, p.LockPhotoTilt, p.LockPhotoRoll, p.LockSizeRad,
			p.DistK1, p.DistK2, p.LockDistK1, p.LockDistK2,
			p.SigmaPhotoAz, p.SigmaPhotoTilt, p.SigmaPhotoRoll,
			p.SigmaSizeRad, p.SigmaDistK1, p.SigmaDistK2)
		return err
	case entityImageMeasurement:
		var im ImageMeasurement
		if err := json.Unmarshal(body, &im); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE image_measurements SET
			  photo_id=$2, u=$3, v=$4, control_point_id=$5, updated_at=NOW()
			WHERE id=$1`,
			id, im.PhotoID, im.U, im.V, im.ControlPointID)
		return err
	case entityControlPoint:
		var cp ControlPoint
		if err := json.Unmarshal(body, &cp); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE control_points SET
			  description=$2, notes=$3, est_lat=$4, est_lng=$5, est_alt=$6,
			  started_at=$7, ended_at=$8,
			  lock_est_lat=$9, lock_est_lng=$10, lock_est_alt=$11,
			  sigma_est_lat=$12, sigma_est_lng=$13, sigma_est_alt=$14, cov_est_lat_lng=$15,
			  started_at_lower=$16, started_at_upper=$17,
			  ended_at_lower=$18, ended_at_upper=$19,
			  derivation_inconsistent=$20,
			  updated_at=NOW()
			WHERE id=$1`,
			id, cp.Description, cp.Notes, cp.EstLat, cp.EstLng, cp.EstAlt,
			cp.StartedAt, cp.EndedAt,
			cp.LockEstLat, cp.LockEstLng, cp.LockEstAlt,
			cp.SigmaEstLat, cp.SigmaEstLng, cp.SigmaEstAlt, cp.CovEstLatLng,
			cp.DerivedWindow.StartedAtLower, cp.DerivedWindow.StartedAtUpper,
			cp.DerivedWindow.EndedAtLower, cp.DerivedWindow.EndedAtUpper,
			cp.DerivedWindow.Inconsistent)
		return err
	case entityCPObservation:
		var o CpObservation
		if err := json.Unmarshal(body, &o); err != nil {
			return err
		}
		var reason *string
		if o.Reason != nil {
			s := string(*o.Reason)
			reason = &s
		}
		_, err := tx.Exec(ctx, `
			UPDATE cp_observations SET
			  station_id=$2, control_point_id=$3, status=$4, reason=$5,
			  updated_at=NOW()
			WHERE id=$1`,
			id, o.StationID, o.ControlPointID, string(o.Status), reason)
		return err
	case entityCPConstraint:
		var c CPConstraint
		if err := json.Unmarshal(body, &c); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE cp_constraints SET
			  cp_a_id=$2, cp_b_id=$3, constraint_type=$4, updated_at=NOW()
			WHERE id=$1`,
			id, c.CpAId, c.CpBId, c.ConstraintType)
		return err
	}
	return fmt.Errorf("update: unknown entity_type %q", entityType)
}

func deleteEntityByID(ctx context.Context, tx pgx.Tx, entityType, id string) error {
	var table string
	switch entityType {
	case entityStation:
		table = "stations"
	case entityPhoto:
		table = "photos"
	case entityImageMeasurement:
		table = "image_measurements"
	case entityControlPoint:
		table = "control_points"
	case entityCPConstraint:
		table = "cp_constraints"
	case entityCPSurface:
		table = "cp_surfaces"
	case entityCPObservation:
		table = "cp_observations"
	default:
		return fmt.Errorf("delete: unknown entity_type %q", entityType)
	}
	// Idempotent: zero rows is fine (the in-session delete may have removed
	// it before the row was ever written to main, e.g. insert+delete coalesce
	// is dropped earlier by collapseOps; but a delete-of-already-deleted via
	// FK cascade arrives here as a no-op).
	_, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE id=$1`, table), id)
	return err
}
