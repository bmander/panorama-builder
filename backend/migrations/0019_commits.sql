-- Linear commit log. seq is the public, monotonic version of HEAD; id is a
-- 13-char base32 like other resources for URL stability. parent_seq is the
-- previous HEAD (NULL for the first commit). source_session_id is NULL for
-- synthetic commits (revert).

CREATE TABLE commits (
  id                  TEXT PRIMARY KEY,
  seq                 BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  parent_seq          BIGINT REFERENCES commits(seq),
  source_session_id   TEXT REFERENCES sessions(id),
  kind                TEXT NOT NULL DEFAULT 'merge'
                      CHECK (kind IN ('merge', 'revert')),
  reverts_commit_id   TEXT REFERENCES commits(id),
  message             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-entity index of "last commit that touched this entity". Updated as
-- part of the merge/revert tx. Conflict detection at merge time reads this.
CREATE TABLE entity_commits (
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  last_seq      BIGINT NOT NULL REFERENCES commits(seq),
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX entity_commits_seq_idx ON entity_commits(last_seq);
