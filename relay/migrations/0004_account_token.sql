-- The token a signed-in account pastes into its desktop and phone apps. Replaces the single owner token.
-- The owner table stays until a later migration, because the Worker running during this migration still reads it.
CREATE TABLE account_token (
  user_id TEXT PRIMARY KEY,              -- the Clerk user
  token_hash TEXT NOT NULL UNIQUE        -- sha256 of the account's current token
);
