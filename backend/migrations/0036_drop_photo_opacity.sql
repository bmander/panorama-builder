-- Photo opacity is now a local, session-only display control on the
-- frontend (how much a photo is dimmed while inspecting alignment), not a
-- persisted property of the photo. It no longer rides through the API,
-- session journal, or solve round-trip, so the column is removed.
--
-- Revert-safe: existing session_ops.before_json/after_json snapshots may
-- still carry an "opacity" key, but the Photo struct no longer has that
-- field, so those keys are simply ignored on unmarshal during session
-- apply / revertCommit. No journaled op references the column after this.

ALTER TABLE photos DROP COLUMN opacity;
