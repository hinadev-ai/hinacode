-- A sign-in waits on the same approval as a machine link. A device link has an empty environment_id.
ALTER TABLE link ADD COLUMN kind TEXT NOT NULL DEFAULT 'machine' CHECK (kind IN ('machine', 'device'));

-- A desktop or phone signed in to an account. Replaces the single token the relay used to have.
-- The owner table stays until a later migration, because the Worker running during this migration still reads it.
CREATE TABLE device (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                 -- the Clerk user
  name TEXT NOT NULL,                    -- shown on the approval page
  credential_hash TEXT NOT NULL UNIQUE,  -- sha256 of the bearer the device holds
  created_at INTEGER NOT NULL
);
CREATE INDEX device_user ON device (user_id);
