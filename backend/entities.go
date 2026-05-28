package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// entities.go is the single source of truth for journaled entity behavior.
//
// Every entity that flows through the session journal (insert/update/delete
// ops, overlay row loading, merge/revert replay, merge ordering, date-graph
// propagation) implements entitySpec and is listed once in entityRegistry.
// Because Go requires a type to implement every method of entitySpec before it
// can be placed in the registry, you cannot add an entity without defining all
// of its operations — the lockstep edits CLAUDE.md used to warn about are now
// enforced by the compiler rather than by hand.
//
// The two residual drifts the compiler cannot see are guarded by
// entities_test.go: (1) that every entityX const is actually registered, and
// (2) that the registry's keys match the session_ops.entity_type CHECK
// constraint in the migrations.
type entitySpec interface {
	// entityType returns the entityX string const that keys this entity in
	// session_ops and in the registry.
	entityType() string
	// rank orders entities for merge-time application: parents before children
	// so foreign-key references resolve (see orderOpsForApply).
	rank() int
	// feedsDateGraph reports whether mutations to this entity feed the STN
	// date propagator. Non-contributors skip propagation on the hot path.
	feedsDateGraph() bool
	// table is the main table name, used for the generic delete and for fetch.
	table() string
	// cols is the SELECT column list used by loadEntityJSONsByType; its shape
	// must match what session_ops journals (Go struct json tags).
	cols() string
	// scanJSON reads one row and returns (id, json-bytes, error).
	scanJSON(pgx.Row) (string, []byte, error)
	// insert writes the full row from a journaled insert snapshot.
	insert(ctx context.Context, tx pgx.Tx, body []byte) error
	// update applies the partial column-diff from a journaled update snapshot.
	update(ctx context.Context, tx pgx.Tx, id string, body []byte) error
}

// entityRegistry maps entity_type -> spec. The single source of truth; build
// once at init from the literal list below.
var entityRegistry = buildEntityRegistry(
	stationSpec{},
	photoSpec{},
	imageMeasurementSpec{},
	controlPointSpec{},
	cpConstraintSpec{},
	cpSurfaceSpec{},
	cpObservationSpec{},
)

func buildEntityRegistry(specs ...entitySpec) map[string]entitySpec {
	m := make(map[string]entitySpec, len(specs))
	for _, sp := range specs {
		t := sp.entityType()
		if _, dup := m[t]; dup {
			panic(fmt.Sprintf("entityRegistry: duplicate entity_type %q", t))
		}
		m[t] = sp
	}
	return m
}

// --- station ---------------------------------------------------------------

type stationSpec struct{}

func (stationSpec) entityType() string   { return entityStation }
func (stationSpec) rank() int            { return 0 }
func (stationSpec) feedsDateGraph() bool { return true }
func (stationSpec) table() string        { return "stations" }
func (stationSpec) cols() string         { return stationCols }

func (stationSpec) scanJSON(r pgx.Row) (string, []byte, error) {
	v, err := scanStation(r)
	if err != nil {
		return "", nil, err
	}
	return v.ID, jsonMust(v), nil
}

func (stationSpec) insert(ctx context.Context, tx pgx.Tx, body []byte) error {
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
}

func (stationSpec) update(ctx context.Context, tx pgx.Tx, id string, body []byte) error {
	b, err := newPartialUpdate(id, body)
	if err != nil {
		return err
	}
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
}

// --- photo ------------------------------------------------------------------

type photoSpec struct{}

func (photoSpec) entityType() string   { return entityPhoto }
func (photoSpec) rank() int            { return 1 }
func (photoSpec) feedsDateGraph() bool { return false }
func (photoSpec) table() string        { return "photos" }
func (photoSpec) cols() string         { return photoCols }

func (photoSpec) scanJSON(r pgx.Row) (string, []byte, error) {
	v, err := scanPhoto(r)
	if err != nil {
		return "", nil, err
	}
	return v.ID, jsonMust(v), nil
}

func (photoSpec) insert(ctx context.Context, tx pgx.Tx, body []byte) error {
	var p Photo
	if err := json.Unmarshal(body, &p); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO photos
		  (id, station_id, blob_path, mime_type, size_bytes, aspect,
		   photo_az, photo_tilt, photo_roll, size_rad,
		   lock_photo_az, lock_photo_tilt, lock_photo_roll, lock_size_rad,
		   dist_k1, dist_k2, lock_dist_k1, lock_dist_k2,
		   sigma_photo_az, sigma_photo_tilt, sigma_photo_roll,
		   sigma_size_rad, sigma_dist_k1, sigma_dist_k2,
		   created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6,
		        $7, $8, $9, $10,
		        $11, $12, $13, $14,
		        $15, $16, $17, $18,
		        $19, $20, $21, $22, $23, $24,
		        $25, NOW())`,
		p.ID, p.StationID, p.BlobPath, p.MimeType, p.SizeBytes, p.Aspect,
		p.PhotoAz, p.PhotoTilt, p.PhotoRoll, p.SizeRad,
		p.LockPhotoAz, p.LockPhotoTilt, p.LockPhotoRoll, p.LockSizeRad,
		p.DistK1, p.DistK2, p.LockDistK1, p.LockDistK2,
		p.SigmaPhotoAz, p.SigmaPhotoTilt, p.SigmaPhotoRoll,
		p.SigmaSizeRad, p.SigmaDistK1, p.SigmaDistK2,
		p.CreatedAt)
	return err
}

func (photoSpec) update(ctx context.Context, tx pgx.Tx, id string, body []byte) error {
	b, err := newPartialUpdate(id, body)
	if err != nil {
		return err
	}
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
}

// --- image_measurement ------------------------------------------------------

type imageMeasurementSpec struct{}

func (imageMeasurementSpec) entityType() string   { return entityImageMeasurement }
func (imageMeasurementSpec) rank() int            { return 3 }
func (imageMeasurementSpec) feedsDateGraph() bool { return false }
func (imageMeasurementSpec) table() string        { return "image_measurements" }
func (imageMeasurementSpec) cols() string         { return imageMeasurementCols }

func (imageMeasurementSpec) scanJSON(r pgx.Row) (string, []byte, error) {
	v, err := scanImageMeasurement(r)
	if err != nil {
		return "", nil, err
	}
	return v.ID, jsonMust(v), nil
}

func (imageMeasurementSpec) insert(ctx context.Context, tx pgx.Tx, body []byte) error {
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
}

func (imageMeasurementSpec) update(ctx context.Context, tx pgx.Tx, id string, body []byte) error {
	b, err := newPartialUpdate(id, body)
	if err != nil {
		return err
	}
	var im ImageMeasurement
	if err := json.Unmarshal(body, &im); err != nil {
		return err
	}
	b.bindIf("photo_id", "photo_id", im.PhotoID).
		bindIf("u", "u", im.U).
		bindIf("v", "v", im.V).
		bindIf("control_point_id", "control_point_id", im.ControlPointID)
	return b.exec(ctx, tx, "image_measurements")
}

// --- control_point ----------------------------------------------------------

type controlPointSpec struct{}

func (controlPointSpec) entityType() string   { return entityControlPoint }
func (controlPointSpec) rank() int            { return 2 }
func (controlPointSpec) feedsDateGraph() bool { return true }
func (controlPointSpec) table() string        { return "control_points" }
func (controlPointSpec) cols() string         { return controlPointCols }

func (controlPointSpec) scanJSON(r pgx.Row) (string, []byte, error) {
	v, err := scanControlPoint(r)
	if err != nil {
		return "", nil, err
	}
	return v.ID, jsonMust(v), nil
}

func (controlPointSpec) insert(ctx context.Context, tx pgx.Tx, body []byte) error {
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
}

func (controlPointSpec) update(ctx context.Context, tx pgx.Tx, id string, body []byte) error {
	b, err := newPartialUpdate(id, body)
	if err != nil {
		return err
	}
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
}

// --- cp_constraint ----------------------------------------------------------

type cpConstraintSpec struct{}

func (cpConstraintSpec) entityType() string   { return entityCPConstraint }
func (cpConstraintSpec) rank() int            { return 4 }
func (cpConstraintSpec) feedsDateGraph() bool { return false }
func (cpConstraintSpec) table() string        { return "cp_constraints" }
func (cpConstraintSpec) cols() string         { return cpConstraintCols }

func (cpConstraintSpec) scanJSON(r pgx.Row) (string, []byte, error) {
	v, err := scanCPConstraint(r)
	if err != nil {
		return "", nil, err
	}
	return v.ID, jsonMust(v), nil
}

func (cpConstraintSpec) insert(ctx context.Context, tx pgx.Tx, body []byte) error {
	var c CPConstraint
	if err := json.Unmarshal(body, &c); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO cp_constraints (id, cp_a_id, cp_b_id, constraint_type, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())`,
		c.ID, c.CpAId, c.CpBId, c.ConstraintType, c.CreatedAt)
	return err
}

func (cpConstraintSpec) update(ctx context.Context, tx pgx.Tx, id string, body []byte) error {
	b, err := newPartialUpdate(id, body)
	if err != nil {
		return err
	}
	var c CPConstraint
	if err := json.Unmarshal(body, &c); err != nil {
		return err
	}
	b.bindIf("cp_a_id", "cp_a_id", c.CpAId).
		bindIf("cp_b_id", "cp_b_id", c.CpBId).
		bindIf("constraint_type", "constraint_type", c.ConstraintType)
	return b.exec(ctx, tx, "cp_constraints")
}

// --- cp_surface -------------------------------------------------------------

type cpSurfaceSpec struct{}

func (cpSurfaceSpec) entityType() string   { return entityCPSurface }
func (cpSurfaceSpec) rank() int            { return 5 }
func (cpSurfaceSpec) feedsDateGraph() bool { return false }
func (cpSurfaceSpec) table() string        { return "cp_surfaces" }
func (cpSurfaceSpec) cols() string         { return cpSurfaceCols }

func (cpSurfaceSpec) scanJSON(r pgx.Row) (string, []byte, error) {
	v, err := scanCPSurface(r)
	if err != nil {
		return "", nil, err
	}
	return v.ID, jsonMust(v), nil
}

func (cpSurfaceSpec) insert(ctx context.Context, tx pgx.Tx, body []byte) error {
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

// cp_surfaces are create/delete-only: no route or solver writeback emits a
// surface update op, so there is nothing to journal or replay. The entitySpec
// contract still forces this method to exist, so the choice is explicit (not a
// silent missing switch case as in issue 44) and a surface update can never
// fall through to a generic "unknown entity_type" error. Returning an error
// rather than a real-but-unreachable UPDATE keeps this rot-proof: there is no
// column list to drift out of sync with the insert as the schema evolves. If
// surface editing is ever added, implement a real partial update here (mirror
// the insert columns) and add a merge/revert replay test.
func (cpSurfaceSpec) update(_ context.Context, _ pgx.Tx, id string, _ []byte) error {
	return fmt.Errorf("cp_surface %s: create/delete-only, no update path is defined", id)
}

// --- cp_observation ---------------------------------------------------------

type cpObservationSpec struct{}

func (cpObservationSpec) entityType() string   { return entityCPObservation }
func (cpObservationSpec) rank() int            { return 6 }
func (cpObservationSpec) feedsDateGraph() bool { return true }
func (cpObservationSpec) table() string        { return "cp_observations" }
func (cpObservationSpec) cols() string         { return cpObservationCols }

func (cpObservationSpec) scanJSON(r pgx.Row) (string, []byte, error) {
	v, err := scanCpObservation(r)
	if err != nil {
		return "", nil, err
	}
	return v.ID, jsonMust(v), nil
}

func (cpObservationSpec) insert(ctx context.Context, tx pgx.Tx, body []byte) error {
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
}

func (cpObservationSpec) update(ctx context.Context, tx pgx.Tx, id string, body []byte) error {
	b, err := newPartialUpdate(id, body)
	if err != nil {
		return err
	}
	var o CpObservation
	if err := json.Unmarshal(body, &o); err != nil {
		return err
	}
	b.bindIf("station_id", "station_id", o.StationID).
		bindIf("control_point_id", "control_point_id", o.ControlPointID).
		bindIf("status", "status", string(o.Status))
	return b.exec(ctx, tx, "cp_observations")
}
