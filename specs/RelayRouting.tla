------------------------------ MODULE RelayRouting ------------------------------
(* One client's link to one machine that runs a relay, as both clients keep it: the desktop in
   src/main/services/Environments.ts (maintain) and the phone in apps/mobile/src/lib/transport.ts.
   Each round races the machine's direct address against the relay, and while on the relay the
   client checks the direct address. A direct session that ends before ready sends the rest of the
   link to the relay alone, and after the check finds the direct address, the next round dials it alone.
   A token the machine rotates reaches the client through the relay service: the machine publishes
   it, and the client syncs it, again and again while the relay refuses the old one.

   The client is on the machine's network or away. Away, someone else's HinaCode may answer at the
   machine's direct address: the same LAN address and default port on another network.

   The link is a state machine in the style of learntla.com/topics/state-machines.html: one
   variable, one `Trans` per edge, and `Next` lists the edges. *)
EXTENDS Naturals

CONSTANTS
  MaxRotations, \* times the machine rotates its token
  MaxMoves,     \* times the client changes networks
  PeriodicSync, \* TRUE for the desktop, which syncs every five minutes. FALSE for the phone, which syncs on launch and foreground
  ProvesToken   \* the client proves it holds the token instead of sending it, since ADR 0022

VARIABLES
  link,         \* the client's state, one of Links
  route,        \* where the socket of this round goes: "none", "direct" or "relay"
  peer,         \* who answers on it: "none", "machine" or "stranger"
  net,          \* "home" is the machine's network
  strangerHere, \* away, a stranger's HinaCode answers at the machine's direct address
  directBroken, \* after a network change, the direct address opens but never answers ready
  machineToken, \* versions of the pairing token: the machine's,
  relayToken,   \* the one the relay service holds,
  clientToken,  \* and the client's
  leaked,       \* the client sent its token to a stranger
  suspect,      \* the direct address refused this link, so its rounds race the relay alone
  directOnly,   \* the direct check found the direct address, so this round dials it alone
  rotations, moves

world == <<net, strangerHere, directBroken, moves>>
tokens == <<machineToken, relayToken, clientToken, rotations>>
dialing == <<suspect, directOnly>>
vars == <<link, route, peer, leaked, dialing, world, tokens>>

Links == {"offline", "racing", "authing", "connected", "unauthorized"}

TypeOK ==
  /\ link \in Links
  /\ route \in {"none", "direct", "relay"}
  /\ peer \in {"none", "machine", "stranger"}
  /\ net \in {"home", "away"}
  /\ strangerHere \in BOOLEAN
  /\ directBroken \in BOOLEAN
  /\ leaked \in BOOLEAN
  /\ suspect \in BOOLEAN /\ directOnly \in BOOLEAN

Trans(from, to) == link = from /\ link' = to

DirectAnswers == net = "home" \/ strangerHere
DirectPeer == IF net = "home" THEN "machine" ELSE "stranger"
Closed == route' = "none" /\ peer' = "none"

Init ==
  /\ link = "offline"
  /\ route = "none" /\ peer = "none"
  /\ net = "home" /\ strangerHere = FALSE /\ directBroken = FALSE
  /\ machineToken = 0 /\ relayToken = 0 /\ clientToken = 0
  /\ leaked = FALSE
  /\ suspect = FALSE /\ directOnly = FALSE
  /\ rotations = 0 /\ moves = 0

\* Environments.ts:596 and transport.ts:456 redial: a new link races both routes and forgets the suspicion.
Dial ==
  /\ Trans("offline", "racing")
  /\ suspect' = FALSE /\ directOnly' = FALSE
  /\ UNCHANGED <<route, peer, leaked, world, tokens>>

\* Environments.ts:560 firstToOpen, transport.ts:102 race: the first socket to open wins, and the auth
\* frame with the token goes to it. The relay always opens; the direct address opens when anyone answers.
\* A relay-alone round leaves out the direct address, and a direct-only round leaves out the relay.
\* With ProvesToken, the winner gets a proof for the challenge server.ts:204 sends (Environments.ts:153,
\* transport.ts:331), and a stranger learns nothing it can use.
Win(r) ==
  /\ Trans("racing", "authing")
  /\ r = "direct" => DirectAnswers /\ ~suspect
  /\ r = "relay" => ~directOnly
  /\ route' = r
  /\ peer' = IF r = "relay" THEN "machine" ELSE DirectPeer
  /\ leaked' = (leaked \/ (peer' = "stranger" /\ ~ProvesToken))
  /\ directOnly' = FALSE
  /\ UNCHANGED <<suspect, world, tokens>>

\* Environments.ts:562, transport.ts:271 noneOpened: the direct-only round finds nobody at the direct
\* address any more, and the next round races both routes without a backoff.
DirectGone ==
  /\ link = "racing" /\ directOnly /\ ~DirectAnswers
  /\ directOnly' = FALSE
  /\ UNCHANGED <<link, route, peer, leaked, suspect, world, tokens>>

\* session: the machine accepts the token and answers ready.
Accept ==
  /\ Trans("authing", "connected")
  /\ peer = "machine" /\ clientToken = machineToken
  /\ route = "direct" => ~directBroken
  /\ UNCHANGED <<route, peer, leaked, dialing, world, tokens>>

Refused == peer = "stranger" \/ clientToken # machineToken

\* Environments.ts maintain, transport.ts triedRelayInstead: a direct session that ends before ready,
\* refused by a stranger or broken by a network change, would win the next race again, so the link
\* stops dialing it and races the relay alone.
DirectFails ==
  /\ Trans("authing", "racing")
  /\ route = "direct" /\ (Refused \/ directBroken)
  /\ suspect' = TRUE
  /\ Closed
  /\ UNCHANGED <<leaked, directOnly, world, tokens>>

\* Environments.ts:585, transport.ts:304: the relay hostname is the machine's own, so its refusal means
\* the token is stale.
RefuseRelay ==
  /\ Trans("authing", "unauthorized")
  /\ route = "relay" /\ Refused
  /\ Closed
  /\ UNCHANGED <<leaked, dialing, world, tokens>>

\* Environments.ts:187 directAnswers and 574, transport.ts:435 checkDirect and 444: on the relay, the
\* direct address opens, so the relay session ends and the next round dials the direct address alone.
MoveToDirect ==
  /\ Trans("connected", "racing")
  /\ route = "relay" /\ DirectAnswers /\ ~suspect
  /\ directOnly' = TRUE
  /\ Closed
  /\ UNCHANGED <<leaked, suspect, world, tokens>>

\* access.ts:97 rotateToken, server.ts:269: every socket to the machine closes with 4002, and the client
\* stops as refused.
Rotate ==
  /\ rotations < MaxRotations
  /\ machineToken' = machineToken + 1 /\ rotations' = rotations + 1
  /\ IF link \in {"authing", "connected"} /\ peer = "machine"
       THEN link' = "unauthorized" /\ Closed
       ELSE UNCHANGED <<link, route, peer>>
  /\ UNCHANGED <<relayToken, clientToken, leaked, dialing, world>>

\* relay.ts:189 publishPairing: some time after a rotation, the relay service holds the new token.
Publish ==
  /\ relayToken # machineToken
  /\ relayToken' = machineToken
  /\ UNCHANGED <<link, route, peer, leaked, dialing, world, machineToken, clientToken, rotations>>

\* RelayAccount.ts:100 sync with Environments.ts:700 syncRelay, and the phone's relay-account store with
\* connection.ts:152 setServers: a changed token restarts the link.
Sync ==
  /\ clientToken # relayToken
  /\ clientToken' = relayToken
  /\ link' = "offline" /\ Closed
  /\ UNCHANGED <<leaked, dialing, world, machineToken, relayToken, rotations>>

\* The client changes networks. The phone redials at once (connection.ts:176 networkChanged); the
\* desktop's socket dies.
Move ==
  /\ moves < MaxMoves
  /\ moves' = moves + 1
  /\ net' \in {"home", "away"}
  /\ strangerHere' \in IF net' = "away" THEN BOOLEAN ELSE {FALSE}
  /\ directBroken' \in BOOLEAN
  /\ IF link \in {"racing", "authing", "connected"}
       THEN link' = "offline" /\ Closed
       ELSE UNCHANGED <<link, route, peer>>
  /\ UNCHANGED <<leaked, dialing, tokens>>

Next ==
  \/ Dial
  \/ Win("relay") \/ Win("direct")
  \/ DirectGone
  \/ Accept \/ DirectFails \/ RefuseRelay
  \/ MoveToDirect
  \/ Rotate \/ Publish \/ Sync
  \/ Move

\* relay-account.ts:127 syncWhileRefused on the phone, and the desktop's five-minute sync: while the
\* relay refuses its token, a client syncs again and again until the new token arrives.
SyncAfterRefusal == link = "unauthorized" /\ Sync

\* The phone syncs on its own only after a refusal. Otherwise it syncs when the owner opens the app,
\* which nothing forces.
Fairness ==
  /\ WF_vars(Dial) /\ WF_vars(Win("relay")) /\ WF_vars(Win("direct")) /\ WF_vars(DirectGone)
  /\ WF_vars(Accept) /\ WF_vars(DirectFails) /\ WF_vars(RefuseRelay)
  /\ WF_vars(MoveToDirect) /\ WF_vars(Publish)
  /\ WF_vars(SyncAfterRefusal)
  /\ PeriodicSync => WF_vars(Sync)

Spec == Init /\ [][Next]_vars /\ Fairness

\* The token reaches the machine only.
TokenStaysWithMachine == ~leaked

\* The client gives up only when its token is stale, never because someone else answered.
GivesUpOnlyOnStaleToken == link = "unauthorized" => clientToken # machineToken

\* Once the client stops moving and the machine stops rotating, the link ends up connected,
\* and at home it ends up on the direct address.
Recovers == <>[](link = "connected")
LocalAtHome == <>[](link = "connected" /\ (net = "home" /\ ~directBroken => route = "direct"))
=============================================================================
