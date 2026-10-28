-- A phone that receives push notifications for the owner it signed in as.
CREATE TABLE device (
  token TEXT PRIMARY KEY,     -- ExponentPushToken[...]
  user_id TEXT NOT NULL,      -- the owner the phone signed in as
  alerts TEXT NOT NULL,       -- JSON array of "completed" | "needsInput" | "failed", the kinds the phone keeps on
  seen_at INTEGER NOT NULL    -- the last registration, in ms
);
