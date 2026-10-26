-- JSON { hosts, port, token } the machine last published, so the owner's devices can pair with it. Null until then.
ALTER TABLE host ADD COLUMN pairing TEXT;
-- Whether the owner shows this machine on their devices.
ALTER TABLE host ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
