-- Sessions are server-issued anonymous workspaces. A user's edits
-- accumulate in the session's append-only journal (session_ops) until they
-- merge it into main as a commit. base_seq is the commits.seq the session
-- was forked from; conflict detection at merge compares each touched entity
-- against entity_commits.last_seq.

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  base_seq    BIGINT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'merged', 'abandoned')),
  next_seq    BIGINT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only operation journal. before_json captures the row state at the
-- moment the op was recorded (NULL for inserts); after_json captures the
-- intended post-state (NULL for deletes). Both are full row snapshots so
-- merge/revert can replay or invert without recomputation.
CREATE TABLE session_ops (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          BIGINT NOT NULL,
  entity_type  TEXT NOT NULL CHECK (entity_type IN
               ('station', 'photo', 'image_measurement', 'control_point', 'cp_constraint')),
  entity_id    TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  before_json  JSONB,
  after_json   JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX session_ops_entity_idx
  ON session_ops (session_id, entity_type, entity_id, seq);
