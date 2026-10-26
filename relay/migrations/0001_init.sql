-- A machine waiting for its owner to approve it, as in OAuth device authorization.
CREATE TABLE link (
  device_code_hash TEXT PRIMARY KEY, -- sha256 of the code only the machine holds
  user_code TEXT NOT NULL UNIQUE,    -- WXYZ-2345, shown in the URL and on the page
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- the machine's hostname, shown on the approval page
  user_id TEXT,                      -- the Clerk user, once approved
  expires_at INTEGER NOT NULL        -- 10 minutes after creation
);

-- A linked machine and its tunnel.
CREATE TABLE host (
  id TEXT PRIMARY KEY,               -- 16 random hex characters, also the hostname label
  user_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE, -- sha256 of the bearer the machine holds
  tunnel_id TEXT,
  dns_record_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, environment_id)
);
