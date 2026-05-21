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
// Inserts serialize the full row (after_json carries every column on insert
// ops). Updates parse the partial column-diff in after_json and emit a
// dynamic UPDATE that only sets the columns the session actually changed —
// matching the on-disk shape session_diff.go shrinks to. `updated_at` is
// always bumped to NOW() so merge ordering stays correct even when no
// user-facing column moved.

// partialUpdate is a thin JSON-key-driven wrapper around the handler-side
// UpdateBuilder. It parses the diff body once into a key set, then defers
// the actual column binding to UpdateBuilder.Set when bindIf is called for
// a key that's present.
type partialUpdate struct {
	keys  map[string]json.RawMessage
	inner *UpdateBuilder
}

func newPartialUpdate(id string, body []byte) (*partialUpdate, error) {
	b := &partialUpdate{inner: newUpdateBuilder(id)}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &b.keys); err != nil {
			return nil, err
		}
	}
	return b, nil
}

func (b *partialUpdate) has(jsonKey string) bool {
	_, ok := b.keys[jsonKey]
	return ok
}

// bindIf binds (col, val) when jsonKey is present in the diff. Returns the
// receiver for chaining.
func (b *partialUpdate) bindIf(jsonKey, col string, val any) *partialUpdate {
	if b.has(jsonKey) {
		b.inner.Set(col, val)
	}
	return b
}

func (b *partialUpdate) exec(ctx context.Context, tx pgx.Tx, table string) error {
	return b.inner.Exec(ctx, tx, table)
}

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
		_, err := tx.Exec(ctx, `
			INSERT INTO cp_observations
			  (id, station_id, control_point_id, status, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, NOW())`,
			o.ID, o.StationID, o.ControlPointID, string(o.Status), o.CreatedAt)
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
	b, err := newPartialUpdate(id, body)
	if err != nil {
		return err
	}
	switch entityType {
	case entityStation:
		var st Station
		if err := json.Unmarshal(body, &st); err != nil {
			return err
		}
		b.bindIf("lat", "lat", st.Lat).
			bindIf("lng", "lng", st.Lng).
			bindIf("alt", "alt", st.Alt).
			bindIf("name", "name", st.Name).
			bindIf("lock_lat", "lock_lat", st.LockLat).
			bindIf("lock_lng", "lock_lng", st.LockLng).
			bindIf("lock_alt", "lock_alt", st.LockAlt).
			bindIf("captured_at", "captured_at", st.CapturedAt).
			bindIf("sigma_lat", "sigma_lat", st.SigmaLat).
			bindIf("sigma_lng", "sigma_lng", st.SigmaLng).
			bindIf("sigma_alt", "sigma_alt", st.SigmaAlt).
			bindIf("cov_lat_lng", "cov_lat_lng", st.CovLatLng)
		if b.has("derived_window") {
			b.inner.Set("captured_at_lower", st.DerivedWindow.CapturedAtLower).
				Set("captured_at_upper", st.DerivedWindow.CapturedAtUpper).
				Set("derivation_inconsistent", st.DerivedWindow.Inconsistent)
		}
		return b.exec(ctx, tx, "stations")
	case entityPhoto:
		var p Photo
		if err := json.Unmarshal(body, &p); err != nil {
			return err
		}
		b.bindIf("station_id", "station_id", p.StationID).
			bindIf("blob_path", "blob_path", p.BlobPath).
			bindIf("mime_type", "mime_type", p.MimeType).
			bindIf("size_bytes", "size_bytes", p.SizeBytes).
			bindIf("aspect", "aspect", p.Aspect).
			bindIf("photo_az", "photo_az", p.PhotoAz).
			bindIf("photo_tilt", "photo_tilt", p.PhotoTilt).
			bindIf("photo_roll", "photo_roll", p.PhotoRoll).
			bindIf("size_rad", "size_rad", p.SizeRad).
			bindIf("opacity", "opacity", p.Opacity).
			bindIf("lock_photo_az", "lock_photo_az", p.LockPhotoAz).
			bindIf("lock_photo_tilt", "lock_photo_tilt", p.LockPhotoTilt).
			bindIf("lock_photo_roll", "lock_photo_roll", p.LockPhotoRoll).
			bindIf("lock_size_rad", "lock_size_rad", p.LockSizeRad).
			bindIf("dist_k1", "dist_k1", p.DistK1).
			bindIf("dist_k2", "dist_k2", p.DistK2).
			bindIf("lock_dist_k1", "lock_dist_k1", p.LockDistK1).
			bindIf("lock_dist_k2", "lock_dist_k2", p.LockDistK2).
			bindIf("sigma_photo_az", "sigma_photo_az", p.SigmaPhotoAz).
			bindIf("sigma_photo_tilt", "sigma_photo_tilt", p.SigmaPhotoTilt).
			bindIf("sigma_photo_roll", "sigma_photo_roll", p.SigmaPhotoRoll).
			bindIf("sigma_size_rad", "sigma_size_rad", p.SigmaSizeRad).
			bindIf("sigma_dist_k1", "sigma_dist_k1", p.SigmaDistK1).
			bindIf("sigma_dist_k2", "sigma_dist_k2", p.SigmaDistK2)
		return b.exec(ctx, tx, "photos")
	case entityImageMeasurement:
		var im ImageMeasurement
		if err := json.Unmarshal(body, &im); err != nil {
			return err
		}
		b.bindIf("photo_id", "photo_id", im.PhotoID).
			bindIf("u", "u", im.U).
			bindIf("v", "v", im.V).
			bindIf("control_point_id", "control_point_id", im.ControlPointID)
		return b.exec(ctx, tx, "image_measurements")
	case entityControlPoint:
		var cp ControlPoint
		if err := json.Unmarshal(body, &cp); err != nil {
			return err
		}
		b.bindIf("description", "description", cp.Description).
			bindIf("notes", "notes", cp.Notes).
			bindIf("est_lat", "est_lat", cp.EstLat).
			bindIf("est_lng", "est_lng", cp.EstLng).
			bindIf("est_alt", "est_alt", cp.EstAlt).
			bindIf("started_at", "started_at", cp.StartedAt).
			bindIf("ended_at", "ended_at", cp.EndedAt).
			bindIf("lock_est_lat", "lock_est_lat", cp.LockEstLat).
			bindIf("lock_est_lng", "lock_est_lng", cp.LockEstLng).
			bindIf("lock_est_alt", "lock_est_alt", cp.LockEstAlt).
			bindIf("sigma_est_lat", "sigma_est_lat", cp.SigmaEstLat).
			bindIf("sigma_est_lng", "sigma_est_lng", cp.SigmaEstLng).
			bindIf("sigma_est_alt", "sigma_est_alt", cp.SigmaEstAlt).
			bindIf("cov_est_lat_lng", "cov_est_lat_lng", cp.CovEstLatLng)
		if b.has("derived_window") {
			b.inner.Set("started_at_lower", cp.DerivedWindow.StartedAtLower).
				Set("started_at_upper", cp.DerivedWindow.StartedAtUpper).
				Set("ended_at_lower", cp.DerivedWindow.EndedAtLower).
				Set("ended_at_upper", cp.DerivedWindow.EndedAtUpper).
				Set("derivation_inconsistent", cp.DerivedWindow.Inconsistent)
		}
		return b.exec(ctx, tx, "control_points")
	case entityCPObservation:
		var o CpObservation
		if err := json.Unmarshal(body, &o); err != nil {
			return err
		}
		b.bindIf("station_id", "station_id", o.StationID).
			bindIf("control_point_id", "control_point_id", o.ControlPointID).
			bindIf("status", "status", string(o.Status))
		return b.exec(ctx, tx, "cp_observations")
	case entityCPConstraint:
		var c CPConstraint
		if err := json.Unmarshal(body, &c); err != nil {
			return err
		}
		b.bindIf("cp_a_id", "cp_a_id", c.CpAId).
			bindIf("cp_b_id", "cp_b_id", c.CpBId).
			bindIf("constraint_type", "constraint_type", c.ConstraintType)
		return b.exec(ctx, tx, "cp_constraints")
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

// loadEntityJSONsByType bulk-reads rows for a set of ids from one entity
// table and returns id → JSON bytes shaped the same way session_ops.before
// _json / after_json are (Go struct json tags, not Postgres' to_jsonb).
// Missing ids are simply absent from the map. Accepts queryerLike so both
// pool reads (overlay construction) and tx reads (merge / revert paths)
// share the same helper.
func loadEntityJSONsByType(ctx context.Context, q queryerLike, entityType string, ids []string) (map[string][]byte, error) {
	if len(ids) == 0 {
		return map[string][]byte{}, nil
	}
	f, ok := entityFetches[entityType]
	if !ok {
		return nil, fmt.Errorf("loadEntityJSONsByType: unknown entity_type %q", entityType)
	}
	rows, err := q.Query(ctx,
		fmt.Sprintf(`SELECT %s FROM %s WHERE id = ANY($1::text[])`, f.cols, f.table), ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]byte, len(ids))
	for rows.Next() {
		id, js, err := f.scanJSON(rows)
		if err != nil {
			return nil, err
		}
		out[id] = js
	}
	return out, rows.Err()
}

// entityFetches dispatches per-type bulk row loading. Each scanJSON reads one
// row and returns (id, json-bytes, error) where the json shape matches what
// session_ops journals.
var entityFetches = map[string]struct {
	cols     string
	table    string
	scanJSON func(pgx.Row) (string, []byte, error)
}{
	entityStation: {stationCols, "stations", func(r pgx.Row) (string, []byte, error) {
		v, err := scanStation(r)
		if err != nil {
			return "", nil, err
		}
		return v.ID, jsonMust(v), nil
	}},
	entityPhoto: {photoCols, "photos", func(r pgx.Row) (string, []byte, error) {
		v, err := scanPhoto(r)
		if err != nil {
			return "", nil, err
		}
		return v.ID, jsonMust(v), nil
	}},
	entityImageMeasurement: {imageMeasurementCols, "image_measurements", func(r pgx.Row) (string, []byte, error) {
		v, err := scanImageMeasurement(r)
		if err != nil {
			return "", nil, err
		}
		return v.ID, jsonMust(v), nil
	}},
	entityControlPoint: {controlPointCols, "control_points", func(r pgx.Row) (string, []byte, error) {
		v, err := scanControlPoint(r)
		if err != nil {
			return "", nil, err
		}
		return v.ID, jsonMust(v), nil
	}},
	entityCPConstraint: {cpConstraintCols, "cp_constraints", func(r pgx.Row) (string, []byte, error) {
		v, err := scanCPConstraint(r)
		if err != nil {
			return "", nil, err
		}
		return v.ID, jsonMust(v), nil
	}},
	entityCPSurface: {cpSurfaceCols, "cp_surfaces", func(r pgx.Row) (string, []byte, error) {
		v, err := scanCPSurface(r)
		if err != nil {
			return "", nil, err
		}
		return v.ID, jsonMust(v), nil
	}},
	entityCPObservation: {cpObservationCols, "cp_observations", func(r pgx.Row) (string, []byte, error) {
		v, err := scanCpObservation(r)
		if err != nil {
			return "", nil, err
		}
		return v.ID, jsonMust(v), nil
	}},
}
