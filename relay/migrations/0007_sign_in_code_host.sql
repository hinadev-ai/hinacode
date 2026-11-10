-- Set when the sign-in returns to one of the account's own machines to approve an app. Only that machine can redeem the code, and it never becomes a device credential.
ALTER TABLE sign_in_code ADD COLUMN host_id TEXT;
