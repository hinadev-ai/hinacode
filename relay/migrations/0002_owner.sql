-- The owner token after its first rotation. Until a row exists, the OWNER_TOKEN secret is the owner token.
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL -- sha256 of the current owner token
);
