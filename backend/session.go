package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sessions and commits — the collaboration layer. A session is an
// append-only journal of mutations against a base commit. Reads to entities
// apply the journal as an overlay; writes record an op rather than touching
// the main tables. Merging promotes the session's terminal state into one
// commit on main; reverting writes an inverse commit.
//
// All write/read endpoints honor the X-Session-Id header. When absent, they
// behave as before. When present, writes are required to be in 'open'
// sessions; reads can target any session (so callers can preview a merged
// session by id, though that's not a v1 UI feature).

const sessionIDHeader = "X-Session-Id"

const (
	entityStation          = "station"
	entityPhoto            = "photo"
	entityImageMeasurement = "image_measurement"
	entityControlPoint     = "control_point"
	entityCPConstraint     = "cp_constraint"
	entityCPSurface        = "cp_surface"
	entityCPObservation    = "cp_observation"
)

// entityRank orders entities for merge-time application: parents before
// children so foreign-key references resolve. A delete of a station inside
// a session must explicitly journal the dependent photo / image-measurement
// deletes ahead of it (handled by deleteStationInSession), so this rank
// applies cleanly to forward replay. Derived from the entityRegistry (each
// spec's rank()) so there is a single source of truth.
var entityRank = func() map[string]int {
	m := make(map[string]int, len(entityRegistry))
	for t, spec := range entityRegistry {
		m[t] = spec.rank()
	}
	return m
}()

type Session struct {
	ID      string
	BaseSeq int64
	Status  string
	NextSeq int64
}

// journalOp is one journaled mutation. before_json/after_json are full row
// snapshots in the canonical JSON shape used by api responses. NULL appears
// as a literal nil []byte (not a JSON 'null' string).
type journalOp struct {
	Seq        int64
	EntityType string
	EntityID   string
	Op         string
	BeforeJSON []byte
	AfterJSON  []byte
}

// entityState is the terminal effect of a session's ops on a single entity.
// deleted=true means the session journaled a delete; otherwise `after`
// holds the post-op row state (nil = "not touched", since map lookups
// return the zero value).
type entityState struct {
	deleted bool
	after   []byte
}

// sessionOverlay maps entity_type → entity_id → terminal state. Constructed
// once per request from the session's journal.
type sessionOverlay map[string]map[string]entityState

func (o sessionOverlay) get(entityType, entityID string) entityState {
	return o[entityType][entityID]
}

// entityKey joins (entity_type, entity_id) into a flat map key. Uses a NUL
// separator because ids are base32 and types are lowercase identifiers, so
// no real value can contain it.
func entityKey(entityType, entityID string) string {
	return entityType + "\x00" + entityID
}

// findSession looks up a session by id. Returns (nil, nil) if not found.
func findSession(ctx context.Context, db *pgxpool.Pool, id string) (*Session, error) {
	if !validID(id) {
		return nil, errors.New("invalid session id")
	}
	var s Session
	err := db.QueryRow(ctx,
		`SELECT id, base_seq, status, next_seq FROM sessions WHERE id=$1`, id,
	).Scan(&s.ID, &s.BaseSeq, &s.Status, &s.NextSeq)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

// tryLoadSession parses X-Session-Id and looks up the row. Returns:
//
//	sess=nil, ok=true  → no header, no session (caller takes direct path)
//	sess set, ok=true  → loaded
//	sess=nil, ok=false → header was bad (sent 400) or DB error (sent 500)
func (s *Server) tryLoadSession(w http.ResponseWriter, r *http.Request) (*Session, bool) {
	id := r.Header.Get(sessionIDHeader)
	if id == "" {
		return nil, true
	}
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid X-Session-Id")
		return nil, false
	}
	sess, err := findSession(r.Context(), s.db, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return nil, false
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return nil, false
	}
	return sess, true
}

// requireOpenSession returns 409 if the session isn't in 'open' status.
func requireOpenSession(w http.ResponseWriter, sess *Session) bool {
	if sess.Status != "open" {
		writeError(w, http.StatusConflict, "session is "+sess.Status)
		return false
	}
	return true
}

// requireSession is the write-handler gate. Every mutating endpoint funnels
// through this so writes can only ever land in a session, never directly on
// main. Returns 428 Precondition Required when the header is absent —
// signals "you must create a session first" without implying auth.
func (s *Server) requireSession(w http.ResponseWriter, r *http.Request) (*Session, bool) {
	id := r.Header.Get(sessionIDHeader)
	if id == "" {
		writeError(w, http.StatusPreconditionRequired, "X-Session-Id is required for writes")
		return nil, false
	}
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid X-Session-Id")
		return nil, false
	}
	sess, err := findSession(r.Context(), s.db, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return nil, false
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return nil, false
	}
	if !requireOpenSession(w, sess) {
		return nil, false
	}
	return sess, true
}

// loadSessionOverlay reads every op for the session, ordered by seq, and
// reduces them into per-entity terminal state. With recordOp coalescing
// eagerly, each entity already has at most one row, but we re-fold here in
// case ops are written through a future path that bypasses recordOp.
//
// For 'update' ops, after_json in session_ops is a partial column diff. We
// reconstruct a full-row JSON for the overlay by bulk-loading the matching
// main rows (one query per entity_type touched) and merging the diff on top,
// so downstream readers see the same full-row shape they always have.
func loadSessionOverlay(ctx context.Context, db queryerLike, sessionID string) (sessionOverlay, error) {
	rows, err := db.Query(ctx, `
		SELECT seq, entity_type, entity_id, op, before_json, after_json
		FROM session_ops
		WHERE session_id = $1
		ORDER BY seq`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	overlay := sessionOverlay{}
	updateIDsByType := map[string][]string{}
	updateOps := []journalOp{}
	for rows.Next() {
		var op journalOp
		if err := rows.Scan(&op.Seq, &op.EntityType, &op.EntityID, &op.Op, &op.BeforeJSON, &op.AfterJSON); err != nil {
			return nil, err
		}
		bucket, ok := overlay[op.EntityType]
		if !ok {
			bucket = map[string]entityState{}
			overlay[op.EntityType] = bucket
		}
		switch op.Op {
		case "insert":
			bucket[op.EntityID] = entityState{after: op.AfterJSON}
		case "update":
			updateIDsByType[op.EntityType] = append(updateIDsByType[op.EntityType], op.EntityID)
			updateOps = append(updateOps, op)
		case "delete":
			bucket[op.EntityID] = entityState{deleted: true}
		default:
			return nil, fmt.Errorf("unknown op kind %q", op.Op)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(updateOps) == 0 {
		return overlay, nil
	}
	mainByKey := make(map[string][]byte, len(updateOps))
	for entityType, ids := range updateIDsByType {
		got, err := loadEntityJSONsByType(ctx, db, entityType, ids)
		if err != nil {
			return nil, err
		}
		for id, js := range got {
			mainByKey[entityKey(entityType, id)] = js
		}
	}
	for _, op := range updateOps {
		main := mainByKey[entityKey(op.EntityType, op.EntityID)]
		merged := mergeFullRowWithDiff(main, op.AfterJSON)
		overlay[op.EntityType][op.EntityID] = entityState{after: merged}
	}
	return overlay, nil
}

// loadSessionOps reads the journal in seq order, without coalescing.
// Used by merge and revert; merge coalesces in code.
func loadSessionOps(ctx context.Context, db *pgxpool.Pool, sessionID string) ([]journalOp, error) {
	rows, err := db.Query(ctx, `
		SELECT seq, entity_type, entity_id, op, before_json, after_json
		FROM session_ops
		WHERE session_id = $1
		ORDER BY seq`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []journalOp
	for rows.Next() {
		var op journalOp
		if err := rows.Scan(&op.Seq, &op.EntityType, &op.EntityID, &op.Op, &op.BeforeJSON, &op.AfterJSON); err != nil {
			return nil, err
		}
		out = append(out, op)
	}
	return out, rows.Err()
}

// recordOp records one mutation against the session journal, coalescing
// with any existing op on the same entity. The journal therefore holds at
// most one row per (session, entity) — moving an observation ten times
// leaves a single update op, not ten.
//
// For 'update' ops, before/after are shrunk to the column-level symmetric
// difference via columnDiff before being written. An empty diff (no columns
// actually changed) drops the op entirely. Inserts and deletes carry the
// full row on their populated side.
//
// Compose rules (existing → new):
//
//	insert + update → insert (after replaced with merged full row)
//	insert + delete → drop the row entirely (no-op for merge)
//	update + update → update (per-column: before = earliest, after = latest;
//	                          empty net diff drops the row)
//	update + delete → delete (before promoted to full row from main snapshot)
//
// 'delete + anything' shouldn't reach here — once an entity is journaled
// as deleted, current*() returns present=false and the caller exits early
// rather than recording a follow-on op.
func recordOp(ctx context.Context, tx pgx.Tx, sessionID, entityType, entityID, op string, before, after []byte) error {
	// Find any existing op for this entity.
	var (
		existingSeq        int64
		existingOp         string
		existingBeforeJSON []byte
		existingAfterJSON  []byte
		hasExisting        bool
	)
	err := tx.QueryRow(ctx, `
		SELECT seq, op, before_json, after_json FROM session_ops
		WHERE session_id=$1 AND entity_type=$2 AND entity_id=$3`,
		sessionID, entityType, entityID,
	).Scan(&existingSeq, &existingOp, &existingBeforeJSON, &existingAfterJSON)
	switch {
	case err == nil:
		hasExisting = true
	case errors.Is(err, pgx.ErrNoRows):
		hasExisting = false
	default:
		return err
	}

	if !hasExisting {
		if op == "update" {
			beforeDiff, afterDiff := columnDiff(before, after)
			if beforeDiff == nil && afterDiff == nil {
				return nil
			}
			before, after = beforeDiff, afterDiff
		}
		return insertFreshOp(ctx, tx, sessionID, entityType, entityID, op, before, after)
	}

	switch {
	case existingOp == "insert" && op == "delete":
		// insert + delete = no-op. Drop the row.
		_, err := tx.Exec(ctx,
			`DELETE FROM session_ops WHERE session_id=$1 AND seq=$2`,
			sessionID, existingSeq)
		return err
	case existingOp == "insert" && op == "update":
		// Keep the insert. The existing after_json is the inserted full row;
		// merge the partial new-update on top so after_json stays a full row.
		// If the update touches nothing, leave the existing row alone.
		_, afterDiff := columnDiff(before, after)
		if afterDiff == nil {
			return nil
		}
		mergedAfter := mergeFullRowWithDiff(existingAfterJSON, afterDiff)
		_, err := tx.Exec(ctx, `
			UPDATE session_ops SET after_json=$3
			WHERE session_id=$1 AND seq=$2`,
			sessionID, existingSeq, mergedAfter)
		return err
	case existingOp == "update" && op == "update":
		newBeforeDiff, newAfterDiff := columnDiff(before, after)
		if newBeforeDiff == nil && newAfterDiff == nil {
			return nil
		}
		mergedBefore, mergedAfter := coalesceUpdateDiff(
			existingBeforeJSON, existingAfterJSON, newBeforeDiff, newAfterDiff)
		if mergedBefore == nil && mergedAfter == nil {
			_, err := tx.Exec(ctx,
				`DELETE FROM session_ops WHERE session_id=$1 AND seq=$2`,
				sessionID, existingSeq)
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE session_ops SET before_json=$3, after_json=$4
			WHERE session_id=$1 AND seq=$2`,
			sessionID, existingSeq, mergedBefore, mergedAfter)
		return err
	case existingOp == "update" && op == "delete":
		// Turn the update into a delete. The caller-supplied `before` is the
		// live full row (= pre-session row with the prior update applied);
		// overlay the partial pre-session values back onto it to recover the
		// pre-session full row, which is what the delete needs to journal
		// so revert can restore the entity in one step.
		preSessionFull := mergeFullRowWithDiff(before, existingBeforeJSON)
		_, err := tx.Exec(ctx, `
			UPDATE session_ops SET op='delete', before_json=$3, after_json=NULL
			WHERE session_id=$1 AND seq=$2`,
			sessionID, existingSeq, preSessionFull)
		return err
	default:
		return fmt.Errorf("unexpected op transition %s + %s", existingOp, op)
	}
}

// insertFreshOp allocates a seq from sessions.next_seq and writes a new op
// row. Used by recordOp when no prior op for the entity exists.
func insertFreshOp(ctx context.Context, tx pgx.Tx, sessionID, entityType, entityID, op string, before, after []byte) error {
	var seq int64
	err := tx.QueryRow(ctx, `
		UPDATE sessions
		SET next_seq = next_seq + 1, updated_at = NOW()
		WHERE id = $1 AND status = 'open'
		RETURNING next_seq - 1`, sessionID,
	).Scan(&seq)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("session not open")
		}
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO session_ops (session_id, seq, entity_type, entity_id, op, before_json, after_json)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		sessionID, seq, entityType, entityID, op, before, after)
	return err
}

// recordOpDirect appends without an existing tx. Convenience for handlers
// that do exactly one op. Wraps in a one-shot tx.
//
// When the op touches a date-graph input the propagator runs in the
// same tx so the overlay never reports stale derived bounds. By
// induction over prior writes, non-date ops can't move any bound — so
// we skip the overlay reload entirely on the hot path for those.
func (s *Server) recordOpDirect(ctx context.Context, sessionID, entityType, entityID, op string, before, after []byte) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := recordOp(ctx, tx, sessionID, entityType, entityID, op, before, after); err != nil {
		return err
	}
	if isDateGraphEntity(entityType) {
		if err := runPropagationInTx(ctx, tx, sessionID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// jsonMust marshals v into JSON; panics on error since our entity types are
// known to be marshalable. Returns nil for a typed-nil pointer.
func jsonMust(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("json marshal: %v", err))
	}
	return b
}

// currentEntity returns the overlay-or-main view of a single entity. The
// overlay wins outright; only on a miss do we fall through to main. Returns
// (zero, false, nil) when the overlay journals a delete or main has no row.
func currentEntity[T any](
	ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay,
	entityType, id string, scan func(pgx.Row) (T, error), loadSQL string,
) (T, bool, error) {
	var zero T
	if st := overlay.get(entityType, id); st.deleted || st.after != nil {
		if st.deleted {
			return zero, false, nil
		}
		var out T
		if err := json.Unmarshal(st.after, &out); err != nil {
			return zero, false, err
		}
		return out, true, nil
	}
	out, err := scan(db.QueryRow(ctx, loadSQL, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return zero, false, nil
		}
		return zero, false, err
	}
	return out, true, nil
}

func currentStation(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, id string) (Station, bool, error) {
	return currentEntity(ctx, db, overlay, entityStation, id, scanStation,
		`SELECT `+stationCols+` FROM stations WHERE id=$1`)
}

func currentPhoto(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, id string) (Photo, bool, error) {
	return currentEntity(ctx, db, overlay, entityPhoto, id, scanPhoto,
		`SELECT `+photoCols+` FROM photos WHERE id=$1`)
}

func currentImageMeasurement(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, id string) (ImageMeasurement, bool, error) {
	return currentEntity(ctx, db, overlay, entityImageMeasurement, id, scanImageMeasurement,
		`SELECT `+imageMeasurementCols+` FROM image_measurements WHERE id=$1`)
}

func currentControlPoint(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, id string) (ControlPoint, bool, error) {
	return currentEntity(ctx, db, overlay, entityControlPoint, id, scanControlPoint,
		`SELECT `+controlPointCols+` FROM control_points WHERE id=$1`)
}

func currentCPConstraint(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, id string) (CPConstraint, bool, error) {
	return currentEntity(ctx, db, overlay, entityCPConstraint, id, scanCPConstraint,
		`SELECT `+cpConstraintCols+` FROM cp_constraints WHERE id=$1`)
}

func currentCPSurface(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, id string) (CPSurface, bool, error) {
	return currentEntity(ctx, db, overlay, entityCPSurface, id, scanCPSurface,
		`SELECT `+cpSurfaceCols+` FROM cp_surfaces WHERE id=$1`)
}

// mergeOverlay folds the session bucket into a main-row slice. For each
// base row, the overlay's entry (if any) overrides — deletes drop the row,
// updates replace it. Session-only inserts that don't appear in base are
// appended at the end. `keep` filters the final list (e.g. "this photo
// still belongs to this station after the overlaid row replaced it").
func mergeOverlay[T any](
	base []T, bucket map[string]entityState,
	idOf func(T) string,
	decode func([]byte) (T, error),
	keep func(T) bool,
) ([]T, error) {
	out := make([]T, 0, len(base))
	seen := make(map[string]bool, len(base))
	for _, b := range base {
		id := idOf(b)
		seen[id] = true
		if st, touched := bucket[id]; touched {
			if st.deleted {
				continue
			}
			r, err := decode(st.after)
			if err != nil {
				return nil, err
			}
			if keep(r) {
				out = append(out, r)
			}
			continue
		}
		if keep(b) {
			out = append(out, b)
		}
	}
	for id, st := range bucket {
		if seen[id] || st.deleted || st.after == nil {
			continue
		}
		r, err := decode(st.after)
		if err != nil {
			return nil, err
		}
		if keep(r) {
			out = append(out, r)
		}
	}
	return out, nil
}

// decodeJSON is the standard overlay decoder — every entity type's
// after_json round-trips through encoding/json.
func decodeJSON[T any](b []byte) (T, error) {
	var v T
	err := json.Unmarshal(b, &v)
	return v, err
}

func applyPhotosOverlay(overlay sessionOverlay, base []Photo, stationID string) ([]Photo, error) {
	return mergeOverlay(base, overlay[entityPhoto],
		func(p Photo) string { return p.ID },
		decodeJSON[Photo],
		func(p Photo) bool { return p.StationID == stationID })
}

func applyImageMeasurementsOverlay(overlay sessionOverlay, base []ImageMeasurement, photoIDs map[string]bool) ([]ImageMeasurement, error) {
	return mergeOverlay(base, overlay[entityImageMeasurement],
		func(im ImageMeasurement) string { return im.ID },
		decodeJSON[ImageMeasurement],
		func(im ImageMeasurement) bool { return photoIDs[im.PhotoID] })
}

func applyControlPointsOverlay(overlay sessionOverlay, base []ControlPoint, want map[string]bool) ([]ControlPoint, error) {
	return mergeOverlay(base, overlay[entityControlPoint],
		func(cp ControlPoint) string { return cp.ID },
		decodeJSON[ControlPoint],
		func(cp ControlPoint) bool { return want[cp.ID] })
}

// --- Apply patch helpers used by *InSession variants. Each takes a typed
// row (already loaded with overlay applied) and a Patch, mutates the row in
// place per the patch fields, and returns nil on success. Validation rules
// mirror the existing SQL-builder paths.

func applyStationPatch(st *Station, p Patch) error {
	if v, present, err := p.Float64("lat"); present {
		if err != nil || !validLat(v) {
			return errors.New("lat out of range")
		}
		st.Lat = v
	}
	if v, present, err := p.Float64("lng"); present {
		if err != nil || !validLng(v) {
			return errors.New("lng out of range")
		}
		st.Lng = v
	}
	if v, present, err := p.Float64("alt"); present {
		if err != nil {
			return err
		}
		st.Alt = v
	}
	if v, present, err := p.NullableString("name"); present {
		if err != nil {
			return err
		}
		st.Name = v
	}
	if v, present, err := p.Bool("lock_lat"); present {
		if err != nil {
			return err
		}
		st.LockLat = v
	}
	if v, present, err := p.Bool("lock_lng"); present {
		if err != nil {
			return err
		}
		st.LockLng = v
	}
	if v, present, err := p.Bool("lock_alt"); present {
		if err != nil {
			return err
		}
		st.LockAlt = v
	}
	if v, present, err := p.NullableTime("captured_at"); present {
		if err != nil {
			return err
		}
		st.CapturedAt = v
	}
	return nil
}

func applyPhotoPatch(p *Photo, patch Patch) error {
	if v, present, err := patch.Float64("aspect"); present {
		if err != nil || v <= 0 || v > 100 {
			return errors.New("aspect must be in (0, 100]")
		}
		p.Aspect = v
	}
	if v, present, err := patch.Float64("photo_az"); present {
		if err != nil {
			return err
		}
		p.PhotoAz = v
	}
	if v, present, err := patch.Float64("photo_tilt"); present {
		if err != nil {
			return err
		}
		p.PhotoTilt = v
	}
	if v, present, err := patch.Float64("photo_roll"); present {
		if err != nil {
			return err
		}
		p.PhotoRoll = v
	}
	if v, present, err := patch.Float64("size_rad"); present {
		if err != nil || v < 0 {
			return errors.New("size_rad must be non-negative")
		}
		p.SizeRad = v
	}
	if v, present, err := patch.Float64("dist_k1"); present {
		if err != nil {
			return err
		}
		p.DistK1 = v
	}
	if v, present, err := patch.Float64("dist_k2"); present {
		if err != nil {
			return err
		}
		p.DistK2 = v
	}
	for key, target := range map[string]*bool{
		"lock_photo_az":   &p.LockPhotoAz,
		"lock_photo_tilt": &p.LockPhotoTilt,
		"lock_photo_roll": &p.LockPhotoRoll,
		"lock_size_rad":   &p.LockSizeRad,
		"lock_dist_k1":    &p.LockDistK1,
		"lock_dist_k2":    &p.LockDistK2,
	} {
		if v, present, err := patch.Bool(key); present {
			if err != nil {
				return err
			}
			*target = v
		}
	}
	return nil
}

func applyImageMeasurementPatch(im *ImageMeasurement, patch Patch) error {
	if v, present, err := patch.Float64("u"); present {
		if err != nil || !validUV(v) {
			return errors.New("u must be in [0, 1]")
		}
		im.U = v
	}
	if v, present, err := patch.Float64("v"); present {
		if err != nil || !validUV(v) {
			return errors.New("v must be in [0, 1]")
		}
		im.V = v
	}
	if v, present, err := patch.NullableID("control_point_id"); present {
		if err != nil {
			return err
		}
		im.ControlPointID = v
	}
	return nil
}

func applyControlPointPatch(cp *ControlPoint, patch Patch) error {
	if v, present, err := patch.String("description"); present {
		if err != nil {
			return err
		}
		cp.Description = v
	}
	if v, present, err := patch.String("notes"); present {
		if err != nil {
			return err
		}
		cp.Notes = v
	}
	if v, present, err := patch.NullableFloat64("est_lat"); present {
		if err != nil || (v != nil && !validLat(*v)) {
			return errors.New("est_lat out of range")
		}
		cp.EstLat = v
	}
	if v, present, err := patch.NullableFloat64("est_lng"); present {
		if err != nil || (v != nil && !validLng(*v)) {
			return errors.New("est_lng out of range")
		}
		cp.EstLng = v
	}
	if v, present, err := patch.NullableFloat64("est_alt"); present {
		if err != nil {
			return err
		}
		cp.EstAlt = v
	}
	if v, present, err := patch.NullableTime("started_at"); present {
		if err != nil {
			return err
		}
		cp.StartedAt = v
	}
	if v, present, err := patch.NullableTime("ended_at"); present {
		if err != nil {
			return err
		}
		cp.EndedAt = v
	}
	if v, present, err := patch.Bool("lock_est_lat"); present {
		if err != nil {
			return err
		}
		cp.LockEstLat = v
	}
	if v, present, err := patch.Bool("lock_est_lng"); present {
		if err != nil {
			return err
		}
		cp.LockEstLng = v
	}
	if v, present, err := patch.Bool("lock_est_alt"); present {
		if err != nil {
			return err
		}
		cp.LockEstAlt = v
	}
	return nil
}
