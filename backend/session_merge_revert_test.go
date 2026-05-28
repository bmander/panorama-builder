package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// session_merge_revert_test.go exercises the load-bearing rollback invariant
// (CLAUDE.md, "Trust model"): every merged change can be reverted from the
// before_json/after_json snapshots in session_ops. Unlike session_diff_test.go
// (which covers op composition in isolation), these tests drive the real write
// handlers → mergeSession → revertCommit against live tables and assert the
// pre-state is restored.
//
// They require a throwaway Postgres+PostGIS database; point TEST_DATABASE_URL
// at one to run them (the docker-compose Postgres works if you create a spare
// database). Without it the suite skips, so `go test ./...` stays green by
// default. Tables are truncated between tests, so never aim TEST_DATABASE_URL
// at a database whose data you care about.

var (
	testPoolOnce sync.Once
	testPool     struct {
		pool *pgxpool.Pool
		err  error
	}
)

// newTestServer connects to TEST_DATABASE_URL (skipping if unset), applies
// migrations once, truncates every domain table for isolation, and returns a
// Server wired to the pool. Only s.db is populated — the merge/revert/write
// handlers under test need nothing else.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres+PostGIS DB to run merge/revert integration tests")
	}
	ctx := context.Background()
	testPoolOnce.Do(func() {
		pool, err := openDB(ctx, url)
		if err != nil {
			testPool.err = err
			return
		}
		testPool.pool = pool
		testPool.err = runMigrations(ctx, pool)
	})
	if testPool.err != nil {
		t.Fatalf("test DB setup: %v", testPool.err)
	}
	s := &Server{db: testPool.pool}
	truncateAll(t, s)
	return s
}

func truncateAll(t *testing.T, s *Server) {
	t.Helper()
	_, err := s.db.Exec(context.Background(), `
		TRUNCATE stations, photos, image_measurements, control_points,
		         cp_constraints, cp_surfaces, cp_observations,
		         sessions, session_ops, commits, entity_commits
		RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// --- handler invocation helpers ---

// jsonReq builds a request with a JSON body and the given path values. The
// path itself is irrelevant (handlers read path values, not the URL), so we
// use "/" throughout.
func jsonReq(t *testing.T, method string, body any, pathVals map[string]string) *http.Request {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, "/", rdr)
	for k, v := range pathVals {
		req.SetPathValue(k, v)
	}
	return req
}

// expect decodes a recorder, asserting the status code and (when out != nil)
// unmarshaling the body into out.
func expect(t *testing.T, rec *httptest.ResponseRecorder, want int, out any) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, want, rec.Body.String())
	}
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
		}
	}
}

// harness bundles the test handle so the per-entity helpers read cleanly.
type harness struct {
	t   *testing.T
	s   *Server
	ctx context.Context
}

func newHarness(t *testing.T) *harness {
	return &harness{t: t, s: newTestServer(t), ctx: context.Background()}
}

// loadSess fetches a fresh open session row. The in-session handlers only use
// sess.ID, but loading keeps the status accurate.
func (h *harness) loadSess(id string) *Session {
	h.t.Helper()
	sess, err := findSession(h.ctx, h.s.db, id)
	if err != nil || sess == nil {
		h.t.Fatalf("load session %s: %v", id, err)
	}
	return sess
}

func (h *harness) openSession() string {
	h.t.Helper()
	rec := httptest.NewRecorder()
	h.s.postSession(rec, jsonReq(h.t, "POST", nil, nil))
	var resp CreateSessionResponse
	expect(h.t, rec, http.StatusCreated, &resp)
	return resp.ID
}

func (h *harness) station(sessID string, lat, lng float64) Station {
	h.t.Helper()
	rec := httptest.NewRecorder()
	body := CreateStationRequest{Lat: lat, Lng: lng}
	h.s.postStationInSession(rec, jsonReq(h.t, "POST", body, nil), h.loadSess(sessID))
	var st Station
	expect(h.t, rec, http.StatusCreated, &st)
	return st
}

func (h *harness) controlPoint(sessID string) ControlPoint {
	h.t.Helper()
	rec := httptest.NewRecorder()
	desc := "landmark"
	body := ControlPointPatch{Description: &desc}
	h.s.postControlPointInSession(rec, jsonReq(h.t, "POST", body, nil), h.loadSess(sessID))
	var cp ControlPoint
	expect(h.t, rec, http.StatusCreated, &cp)
	return cp
}

func (h *harness) photo(sessID, stationID string) Photo {
	h.t.Helper()
	rec := httptest.NewRecorder()
	body := PhotoPosePatch{Aspect: 1.5, SizeRad: 0.5236}
	h.s.postPhotoInSession(rec, jsonReq(h.t, "POST", body, map[string]string{"id": stationID}), h.loadSess(sessID))
	var p Photo
	expect(h.t, rec, http.StatusCreated, &p)
	return p
}

func (h *harness) imageMeasurement(sessID, photoID, cpID string) ImageMeasurement {
	h.t.Helper()
	rec := httptest.NewRecorder()
	body := ImageMeasurementPatch{U: 0.5, V: 0.5}
	if cpID != "" {
		body.ControlPointID = &cpID
	}
	h.s.postImageMeasurementInSession(rec, jsonReq(h.t, "POST", body, map[string]string{"id": photoID}), h.loadSess(sessID))
	var im ImageMeasurement
	expect(h.t, rec, http.StatusCreated, &im)
	return im
}

func (h *harness) updateStationLat(sessID, stationID string, lat float64) {
	h.t.Helper()
	rec := httptest.NewRecorder()
	body := map[string]any{"lat": lat}
	h.s.putStationInSession(rec, jsonReq(h.t, "PUT", body, map[string]string{"id": stationID}), h.loadSess(sessID))
	expect(h.t, rec, http.StatusOK, nil)
}

func (h *harness) deleteStation(sessID, stationID string) {
	h.t.Helper()
	rec := httptest.NewRecorder()
	h.s.deleteStationInSession(rec, jsonReq(h.t, "DELETE", nil, map[string]string{"id": stationID}), h.loadSess(sessID))
	expect(h.t, rec, http.StatusNoContent, nil)
}

// merge merges the session and returns the resulting commit. allow_underdetermined
// is set so the σ gate never blocks — these tests are about the apply/revert
// round trip, not the gate (covered elsewhere).
func (h *harness) merge(sessID string) CommitRef {
	h.t.Helper()
	rec := httptest.NewRecorder()
	body := MergeRequest{SignOff: "test", AllowUnderdetermined: ptr(true)}
	h.s.mergeSession(rec, jsonReq(h.t, "POST", body, map[string]string{"id": sessID}))
	var ref CommitRef
	expect(h.t, rec, http.StatusCreated, &ref)
	return ref
}

// mergeRaw merges without asserting a status, returning the recorder so a test
// can inspect the no-op / error path.
func (h *harness) mergeRaw(sessID string) *httptest.ResponseRecorder {
	h.t.Helper()
	rec := httptest.NewRecorder()
	body := MergeRequest{SignOff: "test", AllowUnderdetermined: ptr(true)}
	h.s.mergeSession(rec, jsonReq(h.t, "POST", body, map[string]string{"id": sessID}))
	return rec
}

func (h *harness) revert(commitID string) CommitRef {
	h.t.Helper()
	rec := httptest.NewRecorder()
	body := RevertRequest{SignOff: "undo"}
	h.s.revertCommit(rec, jsonReq(h.t, "POST", body, map[string]string{"id": commitID}))
	var ref CommitRef
	expect(h.t, rec, http.StatusCreated, &ref)
	return ref
}

// --- main-table assertions ---

func (h *harness) count(table string) int {
	h.t.Helper()
	var n int
	if err := h.s.db.QueryRow(h.ctx, "SELECT COUNT(*) FROM "+table).Scan(&n); err != nil {
		h.t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func (h *harness) exists(table, id string) bool {
	h.t.Helper()
	var ok bool
	if err := h.s.db.QueryRow(h.ctx,
		"SELECT EXISTS(SELECT 1 FROM "+table+" WHERE id=$1)", id).Scan(&ok); err != nil {
		h.t.Fatalf("exists %s/%s: %v", table, id, err)
	}
	return ok
}

func (h *harness) stationLat(id string) float64 {
	h.t.Helper()
	var lat float64
	if err := h.s.db.QueryRow(h.ctx, "SELECT lat FROM stations WHERE id=$1", id).Scan(&lat); err != nil {
		h.t.Fatalf("station lat %s: %v", id, err)
	}
	return lat
}

// --- tests ---

// TestUpdateRevert: seed a station, update its lat in a second session, merge,
// then revert that commit. The pre-update lat must come back from before_json.
func TestUpdateRevert(t *testing.T) {
	h := newHarness(t)

	seed := h.openSession()
	st := h.station(seed, 47.5, -122.3)
	h.merge(seed)
	if got := h.stationLat(st.ID); got != 47.5 {
		t.Fatalf("after seed merge lat = %v, want 47.5", got)
	}

	edit := h.openSession()
	h.updateStationLat(edit, st.ID, 48.0)
	commit := h.merge(edit)
	if got := h.stationLat(st.ID); got != 48.0 {
		t.Fatalf("after edit merge lat = %v, want 48.0", got)
	}

	h.revert(commit.CommitID)
	if got := h.stationLat(st.ID); got != 47.5 {
		t.Fatalf("after revert lat = %v, want 47.5 (pre-state not restored)", got)
	}
}

// TestCascadeDeleteRevert: deleting a station cascades to its photos, image
// measurements, and cp_observations (deleteStationInSession journals each).
// After merge + revert, every cascaded row must reappear — and the control
// point (cross-station, not owned by the station) must be untouched throughout.
func TestCascadeDeleteRevert(t *testing.T) {
	h := newHarness(t)

	seed := h.openSession()
	cp := h.controlPoint(seed)
	st := h.station(seed, 47.5, -122.3)
	p := h.photo(seed, st.ID)
	im := h.imageMeasurement(seed, p.ID, cp.ID) // links to cp → auto-creates a cp_observation
	h.merge(seed)

	if h.count("cp_observations") != 1 {
		t.Fatalf("seed cp_observations = %d, want 1", h.count("cp_observations"))
	}

	del := h.openSession()
	h.deleteStation(del, st.ID)
	commit := h.merge(del)

	// Station + all cascaded dependents gone; the CP survives.
	for _, c := range []struct {
		table string
		want  int
	}{
		{"stations", 0}, {"photos", 0}, {"image_measurements", 0},
		{"cp_observations", 0}, {"control_points", 1},
	} {
		if got := h.count(c.table); got != c.want {
			t.Fatalf("after delete merge %s = %d, want %d", c.table, got, c.want)
		}
	}

	h.revert(commit.CommitID)

	// Everything cascaded comes back from before_json.
	if !h.exists("stations", st.ID) {
		t.Fatalf("station not restored")
	}
	if !h.exists("photos", p.ID) {
		t.Fatalf("photo not restored")
	}
	if !h.exists("image_measurements", im.ID) {
		t.Fatalf("image_measurement not restored")
	}
	if h.count("cp_observations") != 1 {
		t.Fatalf("after revert cp_observations = %d, want 1 (cascade not restored)", h.count("cp_observations"))
	}
	if !h.exists("control_points", cp.ID) {
		t.Fatalf("control point vanished")
	}
}

// TestInsertDeleteCoalesce: an insert followed by a delete of the same entity
// in one session cancels to a no-op (recordOp drops the row). The journal ends
// empty, nothing lands on main, and merge refuses an empty session.
func TestInsertDeleteCoalesce(t *testing.T) {
	h := newHarness(t)

	sess := h.openSession()
	st := h.station(sess, 47.5, -122.3)
	h.deleteStation(sess, st.ID)

	var ops int
	if err := h.s.db.QueryRow(h.ctx,
		"SELECT COUNT(*) FROM session_ops WHERE session_id=$1", sess).Scan(&ops); err != nil {
		t.Fatalf("count ops: %v", err)
	}
	if ops != 0 {
		t.Fatalf("session_ops = %d, want 0 (insert+delete should coalesce away)", ops)
	}

	rec := h.mergeRaw(sess)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("merge of empty session: status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if h.count("stations") != 0 {
		t.Fatalf("stations = %d, want 0 (no-op session must not touch main)", h.count("stations"))
	}
}

// TestEntityRankMergeOrder_DB: a single session that inserts a full FK chain
// (control_point ← image_measurement → photo → station, plus the auto-created
// cp_observation) must merge cleanly. With FKs RESTRICT (migration 0024), a
// wrong apply order would fail loudly; a clean merge proves entityRank lands
// parents before children.
func TestEntityRankMergeOrder_DB(t *testing.T) {
	h := newHarness(t)

	sess := h.openSession()
	cp := h.controlPoint(sess)
	st := h.station(sess, 47.5, -122.3)
	p := h.photo(sess, st.ID)
	h.imageMeasurement(sess, p.ID, cp.ID)
	h.merge(sess)

	for _, c := range []struct {
		table string
		want  int
	}{
		{"control_points", 1}, {"stations", 1}, {"photos", 1},
		{"image_measurements", 1}, {"cp_observations", 1},
	} {
		if got := h.count(c.table); got != c.want {
			t.Fatalf("%s = %d, want %d", c.table, got, c.want)
		}
	}
}

// TestOrderOpsForApply_FKSafeOrdering is a pure (DB-free) check on the ordering
// merge and revert both rely on: inserts first with parents before children,
// then updates, then deletes with children before parents.
func TestOrderOpsForApply_FKSafeOrdering(t *testing.T) {
	// Deliberately scrambled input.
	ops := []journalOp{
		{EntityType: entityImageMeasurement, EntityID: "im1", Op: "insert"},
		{EntityType: entityStation, EntityID: "st1", Op: "insert"},
		{EntityType: entityPhoto, EntityID: "ph1", Op: "insert"},
		{EntityType: entityStation, EntityID: "st2", Op: "delete"},
		{EntityType: entityImageMeasurement, EntityID: "im2", Op: "delete"},
		{EntityType: entityPhoto, EntityID: "ph2", Op: "delete"},
		{EntityType: entityStation, EntityID: "st3", Op: "update"},
	}
	plan := orderOpsForApply(ops)

	pos := map[string]int{}
	for i, op := range plan {
		pos[op.EntityID] = i
	}

	// Phase ordering: every insert before every update before every delete.
	lastInsert, firstUpdate, lastUpdate, firstDelete := -1, len(plan), -1, len(plan)
	for i, op := range plan {
		switch op.Op {
		case "insert":
			if i > lastInsert {
				lastInsert = i
			}
		case "update":
			if i < firstUpdate {
				firstUpdate = i
			}
			if i > lastUpdate {
				lastUpdate = i
			}
		case "delete":
			if i < firstDelete {
				firstDelete = i
			}
		}
	}
	if lastInsert >= firstUpdate {
		t.Fatalf("an insert (idx %d) is not before all updates (first update idx %d)", lastInsert, firstUpdate)
	}
	if lastUpdate >= firstDelete {
		t.Fatalf("an update (idx %d) is not before all deletes (first delete idx %d)", lastUpdate, firstDelete)
	}

	// Insert phase: parents before children (station < photo < image_measurement).
	if !(pos["st1"] < pos["ph1"] && pos["ph1"] < pos["im1"]) {
		t.Fatalf("insert order not parent-first: st1=%d ph1=%d im1=%d", pos["st1"], pos["ph1"], pos["im1"])
	}
	// Delete phase: children before parents (image_measurement < photo < station).
	if !(pos["im2"] < pos["ph2"] && pos["ph2"] < pos["st2"]) {
		t.Fatalf("delete order not child-first: im2=%d ph2=%d st2=%d", pos["im2"], pos["ph2"], pos["st2"])
	}
}
