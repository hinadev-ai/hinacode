-- A pairing now carries the machine's public key instead of its token. Erase the tokens; each machine publishes { hosts, port, key } at its next start.
UPDATE host SET pairing = NULL;
