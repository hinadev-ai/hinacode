-- Set when the owner presses Deny, so the waiting machine learns it was refused instead of waiting for the link to expire.
ALTER TABLE link ADD COLUMN denied INTEGER NOT NULL DEFAULT 0;
