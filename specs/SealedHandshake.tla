---------------------------- MODULE SealedHandshake ----------------------------
(* One remote socket between a client and a machine, as src/shared/handshake.ts and
   src/main/remote/server.ts run it, with an attacker on the path: Cloudflare's edge on the relay, or
   anyone on the network of a direct address. The attacker sees every message, drops any, delivers
   any message it saw or can build, any number of times, to either side. It holds its own key pair
   "a" and a token of its own, "X", but not the pairing token "T" unless it leaks after the client
   connected.

   Crypto is symbolic. A proof names its side, its token and both keys. A sealed message names the
   token and the two keys its channel came from, its direction and its frame counter. Anyone who
   holds the token and one of the two secret keys can build or read it; anyone else can only replay
   it. *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  MachineVersion, \* the machine's protocol: 1 answers in plain text, 2 seals (REMOTE_PROTOCOL_VERSION)
  TokenLeaks,     \* the attacker learns "T" once the client is connected, as from a copy of the relay's D1
  MaxFrames       \* data frames each side sends after `ready`

Keys == {"s", "c", "a"}  \* the machine's, the client's and the attacker's key pair for this socket
Tokens == {"T", "X"}

Proof(side, tok, first, second) == [side |-> side, tok |-> tok, first |-> first, second |-> second]
Key(tok, s, c, dir) == [tok |-> tok, s |-> s, c |-> c, dir |-> dir]
Ready(v, p) == [t |-> "ready", v |-> v, proof |-> p]
Data(from) == [t |-> "data", from |-> from]

Proofs == {Proof(side, tok, x, y) : side \in {"client", "server"}, tok \in Tokens, x \in Keys, y \in Keys}
ChannelKeys == {Key(tok, s, c, dir) : tok \in Tokens, s \in Keys, c \in Keys, dir \in {"toClient", "toServer"}}
Bodies == {Ready(v, p) : v \in {1, 2}, p \in Proofs} \cup {Data("client"), Data("server")}

Challenge(k) == [t |-> "challenge", k |-> k]
Auth(k, p, sealed) == [t |-> "auth", k |-> k, proof |-> p, sealed |-> sealed]
PlainReady(v, p) == [t |-> "plainReady", v |-> v, proof |-> p]
PlainData == [t |-> "plainData"]
Sealed(key, n, body) == [t |-> "sealed", key |-> key, n |-> n, body |-> body]

VARIABLES
  wire,     \* every message either side sent
  leaked,   \* the attacker holds "T"
  client,   \* the client's handshake phase, as ClientState in handshake.ts
  serverKey,\* the nonce the client took from the challenge
  cSent, cRecv, \* the client's frame counters: sealed, and opened
  machine,  \* the machine's phase
  peerKey,  \* the client key the machine accepted
  sSent, sRecv  \* the machine's frame counters

vars == <<wire, leaked, client, serverKey, cSent, cRecv, machine, peerKey, sSent, sRecv>>

AttackerTokens == {"X"} \cup (IF leaked THEN {"T"} ELSE {})

\* The attacker builds a proof of its own token, or of "T" once leaked. Others it can only replay.
CanProve(p) == p.tok \in AttackerTokens

\* A channel key needs the token and one of the two secret keys, and the attacker only holds "a".
CanDerive(k) == k.tok \in AttackerTokens /\ "a" \in {k.s, k.c}

SeenProofs == {m.proof : m \in {w \in wire : w.t \in {"auth", "plainReady"}}}
               \cup {m.body.proof : m \in {w \in wire : w.t = "sealed" /\ CanDerive(w.key) /\ w.body.t = "ready"}}
UsableProofs == SeenProofs \cup {p \in Proofs : CanProve(p)}

\* Everything the attacker can deliver: a replay, or a message it built.
Forged ==
  {Challenge(k) : k \in Keys}
  \cup {Auth(k, p, b) : k \in Keys, p \in UsableProofs, b \in BOOLEAN}
  \cup {PlainReady(v, p) : v \in {1, 2}, p \in UsableProofs}
  \cup {PlainData}
  \cup {Sealed(k, n, body) : k \in {key \in ChannelKeys : CanDerive(key)}, n \in 0..MaxFrames,
                             body \in {Ready(v, p) : v \in {1, 2}, p \in UsableProofs} \cup {Data("client"), Data("server")}}
Deliverable == wire \cup Forged

TypeOK ==
  /\ client \in {"challenged", "authenticating", "sealed", "outdated", "refused", "broken"}
  /\ machine \in {"waiting", "sealed", "plain", "closed"}
  /\ leaked \in BOOLEAN

ClientChannel(dir) == Key("T", serverKey, "c", dir)
MachineChannel(dir) == Key("T", "s", peerKey, dir)

Init ==
  /\ wire = {Challenge("s")}  \* server.ts:232 sends the challenge on connect
  /\ leaked = FALSE
  /\ client = "challenged" /\ serverKey = "none" /\ cSent = 0 /\ cRecv = 0
  /\ machine = "waiting" /\ peerKey = "none" /\ sSent = 0 /\ sRecv = 0

Send(m) == wire' = wire \cup {m}
ClientStays == UNCHANGED <<client, serverKey, cSent, cRecv>>
MachineStays == UNCHANGED <<machine, peerKey, sSent, sRecv>>

\* handshake.ts:136 receivePlain in "challenged": answer the challenge with a sealed auth.
ClientChallenged(m) ==
  /\ client = "challenged"
  /\ IF m.t = "challenge"
       THEN /\ client' = "authenticating" /\ serverKey' = m.k
            /\ Send(Auth("c", Proof("client", "T", m.k, "c"), TRUE))
       ELSE /\ client' = "refused" /\ UNCHANGED <<wire, serverKey>>
  /\ UNCHANGED <<cSent, cRecv>>

\* handshake.ts:155 a plain `ready` counts only from an older machine that proved the token.
ClientPlainWhileAuthenticating(m) ==
  /\ client = "authenticating" /\ m.t # "sealed"
  /\ client' = IF m.t = "plainReady" /\ m.proof = Proof("server", "T", "c", serverKey) /\ m.v < 2
                 THEN "outdated" ELSE "refused"
  /\ UNCHANGED <<wire, serverKey, cSent, cRecv>>

\* handshake.ts:165 receiveSealed: the first frame must open and be a `ready` that proves the token.
ClientSealedWhileAuthenticating(m) ==
  /\ client = "authenticating" /\ m.t = "sealed"
  /\ IF m.key = ClientChannel("toClient") /\ m.n = cRecv
          /\ m.body.t = "ready" /\ m.body.proof = Proof("server", "T", "c", serverKey)
       THEN client' = "sealed" /\ cRecv' = cRecv + 1
       ELSE client' = "refused" /\ UNCHANGED cRecv
  /\ UNCHANGED <<wire, serverKey, cSent>>

\* handshake.ts:152 and 168: after `ready`, a frame that is plain or does not open breaks the link.
ClientConnected(m) ==
  /\ client = "sealed"
  /\ IF m.t = "sealed" /\ m.key = ClientChannel("toClient") /\ m.n = cRecv
       THEN cRecv' = cRecv + 1 /\ UNCHANGED client
       ELSE client' = "broken" /\ UNCHANGED cRecv
  /\ UNCHANGED <<wire, serverKey, cSent>>

ClientReceive(m) ==
  \/ ClientChallenged(m)
  \/ ClientPlainWhileAuthenticating(m)
  \/ ClientSealedWhileAuthenticating(m)
  \/ ClientConnected(m)

\* handshake.ts:178 seal: a call from the client.
ClientSend ==
  /\ client = "sealed" /\ cSent < MaxFrames
  /\ Send(Sealed(ClientChannel("toServer"), cSent, Data("client")))
  /\ cSent' = cSent + 1
  /\ UNCHANGED <<client, serverKey, cRecv>>

\* server.ts:192 authenticate: check the proof, then seal, or tell an unsealed client this version.
MachineAuth(m) ==
  /\ machine = "waiting" /\ m.t = "auth"
  /\ IF m.proof # Proof("client", "T", "s", m.k)
       THEN machine' = "closed" /\ UNCHANGED <<wire, peerKey, sSent>>
     ELSE IF MachineVersion = 1
       THEN /\ machine' = "plain" /\ peerKey' = m.k
            /\ Send(PlainReady(1, Proof("server", "T", m.k, "s"))) /\ UNCHANGED sSent
     ELSE IF ~m.sealed
       THEN /\ machine' = "closed" /\ peerKey' = m.k
            /\ Send(PlainReady(2, Proof("server", "T", m.k, "s"))) /\ UNCHANGED sSent
       ELSE /\ machine' = "sealed" /\ peerKey' = m.k
            /\ Send(Sealed(Key("T", "s", m.k, "toClient"), 0, Ready(2, Proof("server", "T", m.k, "s"))))
            /\ sSent' = 1
  /\ UNCHANGED sRecv

\* server.ts:220 a sealed frame opens only with this socket's channel, in order.
MachineReceive(m) ==
  /\ machine = "sealed" /\ m.t = "sealed"
  /\ IF m.key = MachineChannel("toServer") /\ m.n = sRecv
       THEN sRecv' = sRecv + 1 /\ UNCHANGED machine
       ELSE machine' = "closed" /\ UNCHANGED sRecv
  /\ UNCHANGED <<wire, peerKey, sSent>>

\* An event or a result from the machine. One on protocol 1 sends it readable.
MachineSend ==
  /\ sSent <= MaxFrames
  /\ \/ machine = "sealed" /\ Send(Sealed(MachineChannel("toClient"), sSent, Data("server")))
     \/ machine = "plain" /\ Send(PlainData)
  /\ sSent' = sSent + 1
  /\ UNCHANGED <<machine, peerKey, sRecv>>

Leak ==
  /\ TokenLeaks /\ ~leaked /\ client = "sealed"
  /\ leaked' = TRUE
  /\ UNCHANGED <<wire, client, serverKey, cSent, cRecv, machine, peerKey, sSent, sRecv>>

Next ==
  \/ \E m \in Deliverable : ClientReceive(m) /\ UNCHANGED leaked /\ MachineStays
  \/ \E m \in Deliverable : (MachineAuth(m) \/ MachineReceive(m)) /\ UNCHANGED leaked /\ ClientStays
  \/ ClientSend /\ UNCHANGED leaked /\ MachineStays
  \/ MachineSend /\ UNCHANGED leaked /\ ClientStays
  \/ Leak

Spec == Init /\ [][Next]_vars

\* A connected client shares its channel with the machine, never with the attacker.
ConnectedToMachine == client = "sealed" => serverKey = "s"

\* No frame after `ready` is readable on the wire, even once the token leaks.
FramesStaySealed ==
  \A m \in wire : m.t = "sealed" /\ m.body.t = "data" => ~CanDerive(m.key)

\* The machine runs only calls the client sealed, each once, in order.
MachineRunsOnlyClientCalls == sRecv <= cSent

\* The client never sends a call to an older machine, which would read it in plain text.
NothingToOlderMachine == MachineVersion < 2 => cSent = 0

\* The client says the machine needs an update only when it does. It does not hold: a protocol 1
\* `ready` is plain text, so its version is unauthenticated. The attacker replays the client's auth
\* without `sealed`, the machine answers a plain `ready` that proves the token, and the attacker
\* rewrites its version to 1. The client reads no frame and sends none, so this only stops the link,
\* as a forged close code 4001 already can.
OutdatedOnlyFromOlderMachine == client = "outdated" => MachineVersion < 2
=============================================================================
