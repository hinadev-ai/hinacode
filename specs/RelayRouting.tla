------------------------------ MODULE RelayRouting ------------------------------
(* One client's link to one machine that runs a relay, as the clients keep it: the desktop in
   src/main/services/Environments.ts (maintain), and the phone and the browser app in src/shared/transport.ts
   (Transport), which apps/mobile/src/lib/connection.ts opens for each paired machine.
   Each round races the machine's direct address against the relay, and while on the relay the
   client checks the direct address. A direct session that ends before ready sends the rest of the
   link to the relay alone, and after the check finds the direct address, the next round dials it alone.

   Every session starts with a Noise IK handshake (src/shared/noise.ts) to the host key the client
   pinned, and only a peer that holds that key's private half completes it
   (docs/features/2026-11-25-relay-e2ee.md). The client pins the key from the QR code, which also
   carries a one-time pairing secret, or learns it through the relay service, which holds addresses and
   the host key but no secret. A key from the relay is unverified until the developer types the
   approval code the device shows into the machine and answers Yes on the device.

   The relay is honest or hostile. A hostile relay hands out a host key of its own, routes the relay
   hostname to itself, and signs in a device of its own to ask the machine for approval. Away from
   home, someone else's HinaCode may answer at the machine's direct address: the same LAN address and
   default port on another network. Neither holds the machine's host key.

   The model has no plaintext frame: the client sends nothing but handshake message 1 until the
   channel is up, and its first frame in the channel, hello, carries the secret. So who reads a frame is
   decided by who completed the handshake (Holds). That every frame after message 1 really is binary and
   encrypted is a property of the implementation, which src/main/remote/*.integration.test.ts checks.
   The server acts on nothing before hello, which decrypts only for whoever holds the session's ephemeral
   key, so a message 1 the relay or the LAN recorded and replays opens a session nobody can continue: a
   step that changes nothing here. The approval methods are not callable over a remote session, so only
   the developer at the machine approves and removes devices.

   The link is a state machine in the style of learntla.com/topics/state-machines.html: one
   variable, one `Trans` per edge, and `Next` lists the edges. *)
EXTENDS Integers

CONSTANTS
  MaxResets,   \* times the developer resets the machine's pairing
  MaxRemovals, \* times the developer removes the client from the machine's devices
  MaxMoves     \* times the client changes networks

VARIABLES
  link,          \* the client's state, one of Links
  route,         \* where the socket of this round goes: "none", "direct" or "relay"
  peer,          \* who answers on it: "none", "machine", "stranger" or "relay"
  ready,         \* inside the channel, the peer answered ready
  net,           \* "home" is the machine's network
  strangerHere,  \* away, a stranger's HinaCode answers at the machine's direct address
  directBroken,  \* after a network change, the direct address opens but never answers ready
  generation,    \* the machine's host key, replaced by Reset pairing
  secret,        \* the machine's one-time pairing secret, replaced on enrolling, removing and resetting
  trusted,       \* the devices in the machine's remote_device table: "client" and the relay's own "relay"
  removed,       \* the developer removed the client and has not let it in again since
  relay,         \* "honest" or "hostile", for the whole behavior
  relayKey,      \* the host key the relay service hands out: a generation, or Fake
  hijacked,      \* the relay hostname reaches the relay operator's server instead of the machine's tunnel
  relayAsking,   \* the relay's own device waits for approval on the machine
  pinnedKey,     \* the host key the client pinned: a generation, or Fake
  keyVerified,   \* the pinned key came from the QR code, or the developer confirmed its approval code
  clientSecret,  \* the pairing secret the client holds, or None
  stolenSecret,  \* a secret someone other than the machine decrypted, or None
  suspect,       \* the direct address refused this link, so its rounds race the relay alone
  directOnly,    \* the direct check found the direct address, so this round dials it alone
  resets, removals, moves

None == -1
Fake == -1

session == <<route, peer, ready>>
world == <<net, strangerHere, directBroken, moves>>
machine == <<generation, secret, trusted, removed, resets, removals>>
relayService == <<relay, relayKey, hijacked, relayAsking>>
pairing == <<pinnedKey, keyVerified, clientSecret>>
dialing == <<suspect, directOnly>>
vars == <<link, session, world, machine, relayService, pairing, stolenSecret, dialing>>

Links == {"offline", "racing", "authing", "pending", "connected", "unauthorized"}
Live == {"authing", "pending", "connected"}
Devices == {"client", "relay"}
Keys == {Fake} \cup 0..MaxResets

TypeOK ==
  /\ link \in Links
  /\ route \in {"none", "direct", "relay"}
  /\ peer \in {"none", "machine", "stranger", "relay"}
  /\ ready \in BOOLEAN
  /\ net \in {"home", "away"}
  /\ strangerHere \in BOOLEAN /\ directBroken \in BOOLEAN
  /\ generation \in 0..MaxResets /\ secret \in Nat
  /\ trusted \subseteq Devices /\ removed \in BOOLEAN
  /\ relay \in {"honest", "hostile"}
  /\ relayKey \in Keys /\ pinnedKey \in Keys
  /\ hijacked \in BOOLEAN /\ relayAsking \in BOOLEAN
  /\ keyVerified \in BOOLEAN
  /\ clientSecret \in {None} \cup Nat /\ stolenSecret \in {None} \cup Nat
  /\ suspect \in BOOLEAN /\ directOnly \in BOOLEAN

Trans(from, to) == link = from /\ link' = to

DirectAnswers == net = "home" \/ strangerHere
DirectPeer == IF net = "home" THEN "machine" ELSE "stranger"
RelayPeer == IF hijacked THEN "relay" ELSE "machine"
Closed == route' = "none" /\ peer' = "none" /\ ready' = FALSE

\* Who can complete a handshake to key k: the machine holds only its current host key, Reset pairing having
\* dropped the old one, and the relay holds the key it made up.
Holds(p, k) == (p = "machine" /\ k = generation) \/ (p = "relay" /\ k = Fake)

\* The client starts paired from the QR code, or with a key it learned through the relay.
Init ==
  /\ link = "offline"
  /\ route = "none" /\ peer = "none" /\ ready = FALSE
  /\ net = "home" /\ strangerHere = FALSE /\ directBroken = FALSE
  /\ generation = 0 /\ secret = 0 /\ trusted = {} /\ removed = FALSE
  /\ relay \in {"honest", "hostile"}
  /\ relayKey \in IF relay = "honest" THEN {0} ELSE {0, Fake}
  /\ hijacked = FALSE /\ relayAsking = FALSE
  /\ \/ pinnedKey = 0 /\ keyVerified = TRUE /\ clientSecret = 0
     \/ pinnedKey = relayKey /\ keyVerified = FALSE /\ clientSecret = None
  /\ stolenSecret = None
  /\ suspect = FALSE /\ directOnly = FALSE
  /\ resets = 0 /\ removals = 0 /\ moves = 0

\* Environments.ts maintain resets round to both, and transport.ts redial opens both: a new link races
\* both routes and forgets the suspicion.
Dial ==
  /\ Trans("offline", "racing")
  /\ suspect' = FALSE /\ directOnly' = FALSE
  /\ UNCHANGED <<session, world, machine, relayService, pairing, stolenSecret>>

\* Environments.ts firstToOpen, transport.ts raceToOpen: the first socket to open wins, and the client sends
\* it handshake message 1 (src/shared/noise.ts) to the pinned key. The relay always opens; the direct address
\* opens when anyone answers. A relay-alone round leaves out the direct address, and a direct-only round
\* leaves out the relay.
Win(r) ==
  /\ Trans("racing", "authing")
  /\ r = "direct" => DirectAnswers /\ ~suspect
  /\ r = "relay" => ~directOnly
  /\ route' = r
  /\ peer' = IF r = "relay" THEN RelayPeer ELSE DirectPeer
  /\ directOnly' = FALSE
  /\ UNCHANGED <<ready, suspect, world, machine, relayService, pairing, stolenSecret>>

\* Environments.ts maintain, transport.ts noneOpened: the direct-only round finds nobody at the direct
\* address any more, and the next round races both routes without a backoff.
DirectGone ==
  /\ link = "racing" /\ directOnly /\ ~DirectAnswers
  /\ directOnly' = FALSE
  /\ UNCHANGED <<link, session, world, machine, relayService, pairing, stolenSecret, suspect>>

\* The peer answers handshake message 2, and the direct address answers at all. Otherwise server.ts closes
\* the socket with 4006, or the direct address times out.
Answered == Holds(peer, pinnedKey) /\ (route = "direct" => ~directBroken)

\* src/main/remote/server.ts decides on hello: a trusted device key, or an unknown one with the current
\* secret, gets ready. A client with an unverified key sends verify, and waits for the code.
Enrolls == keyVerified /\ ("client" \in trusted \/ clientSecret = secret)

\* server.ts: the machine adds the device to remote_device, replaces a secret it enrolled with, and answers
\* ready. The client drops its secret once enrolled.
Ready ==
  /\ Trans("authing", "connected")
  /\ peer = "machine" /\ Answered /\ Enrolls
  /\ trusted' = trusted \cup {"client"}
  /\ secret' = IF "client" \in trusted THEN secret ELSE secret + 1
  /\ clientSecret' = None
  /\ ready' = TRUE
  /\ UNCHANGED <<route, peer, world, generation, removed, resets, removals, relayService, pinnedKey, keyVerified,
                 stolenSecret, dialing>>

\* server.ts answers pending, and the machine notifies that a device waits for its code. The relay, holding
\* the key it handed out, reads hello and its secret, and the client waits for the code either way.
Pending ==
  /\ Trans("authing", "pending")
  /\ Answered
  /\ peer = "machine" => ~Enrolls
  /\ stolenSecret' = IF peer # "machine" /\ clientSecret # None THEN clientSecret ELSE stolenSecret
  /\ UNCHANGED <<session, world, machine, relayService, pairing, dialing>>

\* Environments.ts maintain, transport.ts triedRelayInstead: a direct session that ends before ready,
\* answered by someone without the host key or broken by a network change, would win the next race again,
\* so the link stops dialing it and races the relay alone.
DirectFails ==
  /\ Trans("authing", "racing")
  /\ route = "direct" /\ ~Answered
  /\ suspect' = TRUE
  /\ Closed
  /\ UNCHANGED <<directOnly, world, machine, relayService, pairing, stolenSecret>>

\* Environments.ts maintain, transport.ts closed: the relay hostname belongs to the machine, so a handshake
\* that fails there means the machine no longer accepts this device, and the client stops instead of
\* pinning another key.
RefuseRelay ==
  /\ Trans("authing", "unauthorized")
  /\ route = "relay" /\ ~Answered
  /\ Closed
  /\ UNCHANGED <<world, machine, relayService, pairing, stolenSecret, dialing>>

\* server.ts closes a request whose code nobody entered within 5 minutes with 4001. The handshake proved the
\* peer is the machine, so the client stops on either route rather than trying the relay alone, which would
\* keep a client at home on the relay after the developer lets it in.
Expire ==
  /\ Trans("pending", "unauthorized")
  /\ peer = "machine" /\ ~ready
  /\ Closed
  /\ UNCHANGED <<world, machine, relayService, pairing, stolenSecret, dialing>>

\* The developer types the code the device shows into the machine. Both sides derive it from the session's
\* handshake hash and a committed nonce from each side, abstracted as unforgeable: it names a request only
\* when the device's session reaches the machine itself, and never the relay's own device.
CodesMatch(d) == d = "client" /\ link = "pending" /\ peer = "machine"
Asking(d) == IF d = "client" THEN link = "pending" /\ peer = "machine" /\ ~ready ELSE relayAsking

\* remote.devices.approve { code }: the machine trusts the device whose request the code names.
Approve(d) ==
  /\ Asking(d) /\ CodesMatch(d)
  /\ trusted' = trusted \cup {d}
  /\ ready' = (d = "client" \/ ready)
  /\ removed' = (removed /\ d # "client")
  /\ relayAsking' = (relayAsking /\ d # "relay")
  /\ UNCHANGED <<link, route, peer, world, generation, secret, resets, removals, relay, relayKey, hijacked,
                 pairing, stolenSecret, dialing>>

\* transport.ts and Environments.ts: the developer answers Yes to "Did the machine accept the code?",
\* which is true only when the machine took this session's code.
ConfirmCode ==
  /\ ~keyVerified /\ CodesMatch("client") /\ ready
  /\ keyVerified' = TRUE
  /\ UNCHANGED <<link, session, world, machine, relayService, pinnedKey, clientSecret, stolenSecret, dialing>>

\* The client sends no call before ready, and with an unverified key, before the developer answered Yes.
Connect ==
  /\ Trans("pending", "connected")
  /\ ready /\ keyVerified
  /\ UNCHANGED <<session, world, machine, relayService, pairing, stolenSecret, dialing>>

\* Environments.ts directAnswers and maintain, transport.ts checkDirect and redial: on the relay, the
\* direct address opens, so the relay session ends and the next round dials the direct address alone.
MoveToDirect ==
  /\ Trans("connected", "racing")
  /\ route = "relay" /\ DirectAnswers /\ ~suspect
  /\ directOnly' = TRUE
  /\ Closed
  /\ UNCHANGED <<suspect, world, machine, relayService, pairing, stolenSecret>>

\* src/main/remote/access.ts Reset pairing: a new host key and secret, every device removed, every session
\* closed. The client redials and learns from the handshake that the machine no longer accepts it.
Reset ==
  /\ resets < MaxResets
  /\ generation' = generation + 1 /\ secret' = secret + 1 /\ resets' = resets + 1
  /\ trusted' = {} /\ relayAsking' = FALSE
  /\ IF link \in Live /\ peer = "machine"
       THEN link' = "offline" /\ Closed
       ELSE UNCHANGED <<link, session>>
  /\ UNCHANGED <<world, removed, removals, relay, relayKey, hijacked, pairing, stolenSecret, dialing>>

\* remote.devices.remove: the machine ends the device's sessions, forgets it and replaces the secret.
Remove ==
  /\ removals < MaxRemovals /\ "client" \in trusted
  /\ trusted' = trusted \ {"client"} /\ secret' = secret + 1
  /\ removed' = TRUE /\ removals' = removals + 1
  /\ IF link \in Live /\ peer = "machine"
       THEN link' = "offline" /\ Closed
       ELSE UNCHANGED <<link, session>>
  /\ UNCHANGED <<world, generation, resets, relayService, pairing, stolenSecret, dialing>>

\* The developer pairs the stopped client again from the machine's QR code, which pins its key and hands
\* over the current secret.
Repair ==
  /\ link = "unauthorized"
  /\ <<pinnedKey, keyVerified, clientSecret>> # <<generation, TRUE, secret>>
  /\ pinnedKey' = generation /\ keyVerified' = TRUE /\ clientSecret' = secret
  /\ removed' = FALSE
  /\ link' = "offline" /\ Closed
  /\ UNCHANGED <<world, generation, secret, trusted, resets, removals, relayService, stolenSecret, dialing>>

\* transport.ts Pair again, for a device that learns keys from the relay only: it takes the relay's current
\* key, unverified, and goes through the code again. Relay sync itself (RelayAccount.ts sync with
\* Environments.ts syncRelay, and apps/mobile/src/lib/connection.ts setServers) changes nothing about the link:
\* it never pins a key, and a key other than the pinned one neither stops nor restarts the client, so only the
\* link's own handshake stops it.
PairAgain ==
  /\ link = "unauthorized"
  /\ <<pinnedKey, keyVerified, clientSecret>> # <<relayKey, FALSE, None>>
  /\ pinnedKey' = relayKey /\ keyVerified' = FALSE /\ clientSecret' = None
  /\ link' = "offline" /\ Closed
  /\ UNCHANGED <<world, machine, relayService, stolenSecret, dialing>>

\* src/main/remote/relay.ts publishPairing: some time after a reset, the relay service holds the new key.
Publish ==
  /\ relayKey # generation
  /\ relayKey' = generation
  /\ UNCHANGED <<link, session, world, machine, relay, hijacked, relayAsking, pairing, stolenSecret, dialing>>

\* The client changes networks. In the foreground the phone redials at once (apps/mobile/src/lib/connection.ts
\* networkChanged), and in the background it waits for the foreground; the desktop's socket dies.
Move ==
  /\ moves < MaxMoves
  /\ moves' = moves + 1
  /\ net' \in {"home", "away"}
  /\ strangerHere' \in IF net' = "away" THEN BOOLEAN ELSE {FALSE}
  /\ directBroken' \in BOOLEAN
  /\ IF link \in Live \cup {"racing"}
       THEN link' = "offline" /\ Closed
       ELSE UNCHANGED <<link, session>>
  /\ UNCHANGED <<machine, relayService, pairing, stolenSecret, dialing>>

\* A hostile relay hands out a key of its own, or the machine's again.
SwapKey ==
  /\ relay = "hostile"
  /\ relayKey' \in {Fake, generation} \ {relayKey}
  /\ UNCHANGED <<link, session, world, machine, relay, hijacked, relayAsking, pairing, stolenSecret, dialing>>

\* A hostile relay routes the relay hostname to its own server, or back, which cuts a relay session.
Reroute ==
  /\ relay = "hostile"
  /\ hijacked' = ~hijacked
  /\ IF link \in Live /\ route = "relay"
       THEN link' = "offline" /\ Closed
       ELSE UNCHANGED <<link, session>>
  /\ UNCHANGED <<world, machine, relay, relayKey, relayAsking, pairing, stolenSecret, dialing>>

\* A hostile relay signs in a device of its own, which waits for a code on the machine.
RelayAsks ==
  /\ relay = "hostile" /\ ~relayAsking /\ "relay" \notin trusted
  /\ relayAsking' = TRUE
  /\ UNCHANGED <<link, session, world, machine, relay, relayKey, hijacked, pairing, stolenSecret, dialing>>

\* With the current secret it decrypted, the relay's device would enroll like a scanned QR code.
RelayEnrolls ==
  /\ relay = "hostile" /\ stolenSecret = secret /\ "relay" \notin trusted
  /\ trusted' = trusted \cup {"relay"} /\ secret' = secret + 1
  /\ UNCHANGED <<link, session, world, generation, removed, resets, removals, relayService, pairing,
                 stolenSecret, dialing>>

\* The relay's server, holding a session the client opened to its key, answers ready or hangs up.
RelayReady ==
  /\ link = "pending" /\ peer = "relay" /\ ~ready
  /\ ready' = TRUE
  /\ UNCHANGED <<link, route, peer, world, machine, relayService, pairing, stolenSecret, dialing>>

RelayHangsUp ==
  /\ Trans("pending", "unauthorized")
  /\ peer = "relay"
  /\ Closed
  /\ UNCHANGED <<world, machine, relayService, pairing, stolenSecret, dialing>>

Next ==
  \/ Dial
  \/ Win("relay") \/ Win("direct")
  \/ DirectGone
  \/ Ready \/ Pending \/ DirectFails \/ RefuseRelay \/ Expire
  \/ Approve("client") \/ Approve("relay") \/ ConfirmCode \/ Connect
  \/ MoveToDirect
  \/ Reset \/ Remove \/ Repair \/ PairAgain
  \/ Publish
  \/ Move
  \/ SwapKey \/ Reroute \/ RelayAsks \/ RelayEnrolls \/ RelayReady \/ RelayHangsUp

\* The developer types the code of a device they are adding, answers Yes when the machine took it, and lets
\* the request of a device they removed expire. Reset pairing, Remove, and pairing again are their choice.
Fairness ==
  /\ WF_vars(Dial) /\ WF_vars(Win("relay")) /\ WF_vars(Win("direct")) /\ WF_vars(DirectGone)
  /\ WF_vars(Ready) /\ WF_vars(Pending) /\ WF_vars(DirectFails) /\ WF_vars(RefuseRelay)
  /\ WF_vars(~removed /\ Approve("client")) /\ WF_vars(ConfirmCode) /\ WF_vars(Connect)
  /\ WF_vars(removed /\ Expire)
  /\ WF_vars(MoveToDirect) /\ WF_vars(Publish)

Spec == Init /\ [][Next]_vars /\ Fairness

\* The pairing secret reaches the machine only.
SecretStaysWithMachine == stolenSecret = None

\* Calls flow only to the machine that holds the real host key.
CallsReachOnlyMachine == link = "connected" => peer = "machine" /\ pinnedKey = generation

\* The machine never trusts the relay's own device.
RelayCannotEnroll == "relay" \notin trusted

\* A removed device stays out until the developer enters its code or pairs it from the QR code again.
RemovedStaysOut == removed => "client" \notin trusted /\ link # "connected"

\* The machine reset its key, or does not trust this device and its key yet.
NotAccepted == pinnedKey # generation \/ ~("client" \in trusted /\ keyVerified)

\* The client stops only when the relay is hostile or the machine does not accept it, never because someone
\* else answered at the direct address or the relay handed out another key.
StopsOnlyWhenRefused == [][link # "unauthorized" /\ link' = "unauthorized" => relay = "hostile" \/ NotAccepted]_vars

\* With an honest relay, once the client stops moving and the developer stops resetting, the link ends up
\* connected, and at home on the direct address, unless the machine does not accept the client.
Stopped == link = "unauthorized" /\ NotAccepted
Recovers == relay = "honest" => <>[](link = "connected" \/ Stopped)
LocalAtHome ==
  relay = "honest" => <>[]((link = "connected" /\ (net = "home" /\ ~directBroken => route = "direct")) \/ Stopped)
=============================================================================
