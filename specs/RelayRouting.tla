------------------------------ MODULE RelayRouting ------------------------------
(* One client's link to one machine that runs a relay, as both clients keep it: the desktop in
   src/main/services/Environments.ts (maintain) and the phone in apps/mobile/src/lib/transport.ts.
   Each round races the machine's direct address against the relay, and while on the relay the
   client checks the direct address. A token the machine rotates reaches the client through the
   relay service: the machine publishes it, and the client syncs it.

   The client is on the machine's network or away. Away, someone else's HinaCode may answer at the
   machine's direct address: the same LAN address and default port on another network.

   The link is a state machine in the style of learntla.com/topics/state-machines.html: one
   variable, one `Trans` per edge, and `Next` lists the edges. *)
EXTENDS Naturals

CONSTANTS
  MaxRotations, \* times the machine rotates its token
  MaxMoves,     \* times the client changes networks
  PeriodicSync  \* TRUE for the desktop, which syncs every five minutes. FALSE for the phone, which syncs on launch and foreground

VARIABLES
  link,         \* the client's state, one of Links
  route,        \* where the socket of this round goes: "none", "direct" or "relay"
  peer,         \* who answers on it: "none", "machine" or "stranger"
  net,          \* "home" is the machine's network
  strangerHere, \* away, a stranger's HinaCode answers at the machine's direct address
  machineToken, \* versions of the pairing token: the machine's,
  relayToken,   \* the one the relay service holds,
  clientToken,  \* and the client's
  leaked,       \* the client sent its token to a stranger
  rotations, moves

world == <<net, strangerHere, moves>>
tokens == <<machineToken, relayToken, clientToken, rotations>>
vars == <<link, route, peer, leaked, world, tokens>>

Links == {"offline", "racing", "authing", "connected", "unauthorized"}

TypeOK ==
  /\ link \in Links
  /\ route \in {"none", "direct", "relay"}
  /\ peer \in {"none", "machine", "stranger"}
  /\ net \in {"home", "away"}
  /\ strangerHere \in BOOLEAN
  /\ leaked \in BOOLEAN

Trans(from, to) == link = from /\ link' = to

DirectAnswers == net = "home" \/ strangerHere
DirectPeer == IF net = "home" THEN "machine" ELSE "stranger"
Closed == route' = "none" /\ peer' = "none"

Init ==
  /\ link = "offline"
  /\ route = "none" /\ peer = "none"
  /\ net = "home" /\ strangerHere = FALSE
  /\ machineToken = 0 /\ relayToken = 0 /\ clientToken = 0
  /\ leaked = FALSE
  /\ rotations = 0 /\ moves = 0

\* Environments.ts:548 maintain, transport.ts open: a round starts.
Dial ==
  /\ Trans("offline", "racing")
  /\ UNCHANGED <<route, peer, leaked, world, tokens>>

\* Environments.ts:162 firstToOpen, transport.ts:96 race: the first socket to open wins, and the auth
\* frame with the token goes to it. The relay always opens; the direct address opens when anyone answers.
Win(r) ==
  /\ Trans("racing", "authing")
  /\ r = "direct" => DirectAnswers
  /\ route' = r
  /\ peer' = IF r = "relay" THEN "machine" ELSE DirectPeer
  /\ leaked' = (leaked \/ peer' = "stranger")
  /\ UNCHANGED <<world, tokens>>

\* session: the machine accepts the token and answers ready.
Accept ==
  /\ Trans("authing", "connected")
  /\ peer = "machine" /\ clientToken = machineToken
  /\ UNCHANGED <<route, peer, leaked, world, tokens>>

\* Environments.ts:564, transport.ts:270: a 4001 from whoever answered stops the link until its token changes.
Refuse ==
  /\ Trans("authing", "unauthorized")
  /\ peer = "stranger" \/ clientToken # machineToken
  /\ Closed
  /\ UNCHANGED <<leaked, world, tokens>>

\* Environments.ts:186 directAnswers, transport.ts checkDirect: on the relay, the direct address opens,
\* so the relay session ends and a round starts at once.
MoveToDirect ==
  /\ Trans("connected", "racing")
  /\ route = "relay" /\ DirectAnswers
  /\ Closed
  /\ UNCHANGED <<leaked, world, tokens>>

\* access.ts rotateToken, server.ts:269: every socket to the machine closes with 4002, which the client
\* treats like a refusal.
Rotate ==
  /\ rotations < MaxRotations
  /\ machineToken' = machineToken + 1 /\ rotations' = rotations + 1
  /\ IF link \in {"authing", "connected"} /\ peer = "machine"
       THEN link' = "unauthorized" /\ Closed
       ELSE UNCHANGED <<link, route, peer>>
  /\ UNCHANGED <<relayToken, clientToken, leaked, world>>

\* relay.ts publishPairing: some time after a rotation, the relay service holds the new token.
Publish ==
  /\ relayToken # machineToken
  /\ relayToken' = machineToken
  /\ UNCHANGED <<link, route, peer, leaked, world, machineToken, clientToken, rotations>>

\* RelayAccount.ts sync with Environments.syncRelay, and the phone's relay-account store with
\* connection.ts setServers: a changed token restarts the link.
Sync ==
  /\ clientToken # relayToken
  /\ clientToken' = relayToken
  /\ link' = "offline" /\ Closed
  /\ UNCHANGED <<leaked, world, machineToken, relayToken, rotations>>

\* The client changes networks. The phone redials at once (networkChanged); the desktop's socket dies.
Move ==
  /\ moves < MaxMoves
  /\ moves' = moves + 1
  /\ net' \in {"home", "away"}
  /\ strangerHere' \in IF net' = "away" THEN BOOLEAN ELSE {FALSE}
  /\ IF link \in {"racing", "authing", "connected"}
       THEN link' = "offline" /\ Closed
       ELSE UNCHANGED <<link, route, peer>>
  /\ UNCHANGED <<leaked, tokens>>

Next ==
  \/ Dial
  \/ Win("relay") \/ Win("direct")
  \/ Accept \/ Refuse
  \/ MoveToDirect
  \/ Rotate \/ Publish \/ Sync
  \/ Move

\* The phone syncs only when the owner opens the app, which nothing forces.
Fairness ==
  /\ WF_vars(Dial) /\ WF_vars(Win("relay")) /\ WF_vars(Accept) /\ WF_vars(Refuse)
  /\ WF_vars(MoveToDirect) /\ WF_vars(Publish)
  /\ PeriodicSync => WF_vars(Sync)

Spec == Init /\ [][Next]_vars /\ Fairness

\* The token reaches the machine only.
TokenStaysWithMachine == ~leaked

\* The client gives up only when its token is stale, never because someone else answered.
GivesUpOnlyOnStaleToken == link = "unauthorized" => clientToken # machineToken

\* Once the client stops moving and the machine stops rotating, the link ends up connected,
\* and at home it ends up on the direct address.
Recovers == <>[](link = "connected")
LocalAtHome == <>[](link = "connected" /\ (net = "home" => route = "direct"))
=============================================================================
