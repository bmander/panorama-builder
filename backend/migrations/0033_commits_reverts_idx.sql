-- Speeds up the op_count subquery on the commit list endpoint, which joins
-- session_ops to the commit being reverted via commits.reverts_commit_id.
CREATE INDEX IF NOT EXISTS commits_reverts_commit_id_idx
  ON commits(reverts_commit_id)
  WHERE reverts_commit_id IS NOT NULL;
