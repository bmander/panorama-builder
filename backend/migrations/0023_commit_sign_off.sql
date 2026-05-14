-- Free-form attestation captured from the user at merge time. Required for
-- merges going forward; existing rows backfill to '' so the NOT NULL holds.
ALTER TABLE commits ADD COLUMN sign_off TEXT NOT NULL DEFAULT '';
