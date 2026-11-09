-- A sign-in that redirected back to the app with a code, waiting for the app to exchange it with its PKCE verifier.
CREATE TABLE sign_in_code (
  code_hash TEXT PRIMARY KEY,     -- sha256 hex of the code in the redirect
  code_challenge TEXT NOT NULL,   -- base64url sha256 of the verifier only the app holds
  user_id TEXT NOT NULL,          -- the Clerk user who signed in
  name TEXT NOT NULL,             -- the device name, kept on the device row
  expires_at INTEGER NOT NULL     -- 2 minutes after the redirect
);
