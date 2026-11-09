------------------------------ MODULE SettleRelease ------------------------------
(* Settling and auto-archiving one thread while the developer and the agent keep using it.
   The manual settle and the sweep's idle and archive passes in src/main/services/Settle.ts hand their cleanup to
   AgentRunner.release (src/main/services/AgentRunner.ts), which runs it under the thread's lock once no turn
   holds the thread. Racing them: a send from the composer (rpc.ts threads.send, AgentRunner.sendWhen and
   startTurn), the agent waking itself for a finished background task (AgentRunner.startWake), and Pin and Reopen
   (Threads.update, Threads.unsettle), which take the worktree lock and not the thread's. *)
EXTENDS Naturals

CONSTANTS MaxSends, MaxWakes

VARIABLES
  status,     \* thread.status: idle, running (a turn holds it, awaiting_approval included) or archived
  settled,    \* thread.settled_at is set
  pinned,     \* thread.pinned_at is set
  background, \* a sub-agent or background task the agent left running after its turn
  listener,   \* a process the agent started that listens on a port, such as a dev server
  claim,      \* AgentRunner.isBusy: none, or who holds busyThreads and pendingSends: a send, a wake or a turn
  lock,       \* AgentRunner's per-thread Semaphore, held by release across its cleanup
  sendPc,     \* the developer's send: idle, waiting for startTurn's first locked block, or for its second
  wakePc,     \* startWake: idle, or claimed and waiting for the lock
  relPc,      \* release: idle, stopping tasks, cleaning under the lock, or writing the row
  relKind,    \* who runs release: a manual settle, the sweep's idle pass or its archive pass
  sendsLeft, wakesLeft,
  refused     \* history: a send to a thread that was not archived when the developer sent it was refused

vars == <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
          sendsLeft, wakesLeft, refused>>

IsBusy == claim # "none"

Init ==
  /\ status = "idle" /\ settled = FALSE /\ pinned = FALSE
  /\ background = FALSE /\ listener = FALSE
  /\ claim = "none" /\ lock = "free"
  /\ sendPc = "idle" /\ wakePc = "idle" /\ relPc = "idle" /\ relKind = "settle"
  /\ sendsLeft = MaxSends /\ wakesLeft = MaxWakes
  /\ refused = FALSE

---------------------------------------------------------------------------------------------------------------
\* The developer's send.

\* rpc.ts threads.send unarchives an archived thread, then AgentRunner.ts:1173 sendWhen claims busyThreads without
\* the lock. The composer steers rather than sends while a turn runs, so the claim never fails here.
SendClaims ==
  /\ sendsLeft > 0 /\ sendPc = "idle" /\ ~IsBusy
  /\ sendsLeft' = sendsLeft - 1
  /\ claim' = "send" /\ sendPc' = "first"
  /\ IF status = "archived"
       THEN status' = "idle" /\ settled' = FALSE
       ELSE UNCHANGED <<status, settled>>
  /\ UNCHANGED <<pinned, background, listener, lock, wakePc, relPc, relKind, wakesLeft, refused>>

\* AgentRunner.ts:1061 startTurn's first exclusive block promotes a draft and prepares the workspace.
SendFirstBlock ==
  /\ sendPc = "first" /\ lock = "free"
  /\ sendPc' = "second"
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, wakePc, relPc, relKind,
                 sendsLeft, wakesLeft, refused>>

\* AgentRunner.ts:1100 the second exclusive block refuses an archived thread, or marks it running.
\* Threads.write clears settled_at when a turn starts work.
SendSecondBlock ==
  /\ sendPc = "second" /\ lock = "free"
  /\ sendPc' = "idle"
  /\ IF status = "archived"
       THEN /\ claim' = "none" /\ refused' = TRUE
            /\ UNCHANGED <<status, settled>>
       ELSE /\ claim' = "turn" /\ status' = "running" /\ settled' = FALSE
            /\ UNCHANGED refused
  /\ UNCHANGED <<pinned, background, listener, lock, wakePc, relPc, relKind, sendsLeft, wakesLeft>>

---------------------------------------------------------------------------------------------------------------
\* The agent.

\* A turn starts a dev server, or a sub-agent or background task that outlives the turn.
TurnStartsListener ==
  /\ status = "running" /\ ~listener
  /\ listener' = TRUE
  /\ UNCHANGED <<status, settled, pinned, background, claim, lock, sendPc, wakePc, relPc, relKind,
                 sendsLeft, wakesLeft, refused>>

TurnStartsBackground ==
  /\ status = "running" /\ ~background
  /\ background' = TRUE
  /\ UNCHANGED <<status, settled, pinned, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 sendsLeft, wakesLeft, refused>>

\* AgentRunner.ts:749 finish, under the thread lock, sets the thread idle and drops the claim.
TurnEnds ==
  /\ status = "running" /\ lock = "free"
  /\ status' = "idle" /\ claim' = "none"
  /\ UNCHANGED <<settled, pinned, background, listener, lock, sendPc, wakePc, relPc, relKind,
                 sendsLeft, wakesLeft, refused>>

\* AgentRunner.ts:1500 startWake: a finished background task wakes the agent. It waits out busyThreads and claims.
WakeClaims ==
  /\ wakesLeft > 0 /\ background /\ wakePc = "idle" /\ ~IsBusy
  /\ wakesLeft' = wakesLeft - 1
  /\ claim' = "wake" /\ wakePc' = "waiting" /\ background' = FALSE
  /\ UNCHANGED <<status, settled, pinned, listener, lock, sendPc, relPc, relKind, sendsLeft, refused>>

\* Under both locks, an archived thread drops the wake, and any other starts a turn.
WakeAdopts ==
  /\ wakePc = "waiting" /\ lock = "free"
  /\ wakePc' = "idle"
  /\ IF status = "archived"
       THEN claim' = "none" /\ UNCHANGED <<status, settled>>
       ELSE claim' = "turn" /\ status' = "running" /\ settled' = FALSE
  /\ UNCHANGED <<pinned, background, listener, lock, sendPc, relPc, relKind, sendsLeft, wakesLeft, refused>>

---------------------------------------------------------------------------------------------------------------
\* The developer's row actions, each one write under the worktree lock.

\* Threads.ts:539 update with pinned: true, which clears settled_at.
Pin ==
  /\ status # "archived" /\ ~pinned
  /\ pinned' = TRUE /\ settled' = FALSE
  /\ UNCHANGED <<status, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 sendsLeft, wakesLeft, refused>>

Unpin ==
  /\ pinned
  /\ pinned' = FALSE
  /\ UNCHANGED <<status, settled, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 sendsLeft, wakesLeft, refused>>

\* Threads.ts:855 unsettle.
Reopen ==
  /\ settled
  /\ settled' = FALSE
  /\ UNCHANGED <<status, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 sendsLeft, wakesLeft, refused>>

---------------------------------------------------------------------------------------------------------------
\* Settle and archive, through AgentRunner.ts:1659 release.

\* Settle.ts:80 settle checks the row is not busy. Settle.ts:121 settleIfIdle rereads the row after GitHub and
\* the port scan answer, and needs no pin, no settle, no agent work and no listener. Settle.ts:150
\* archiveIfSettledLong needs a settled, unpinned row. Then release checks isBusy before its first await.
ReleaseStarts(kind) ==
  /\ relPc = "idle" /\ status = "idle" /\ ~IsBusy
  /\ CASE kind = "settle" -> ~settled
       [] kind = "idleSettle" -> ~settled /\ ~pinned /\ ~background /\ ~listener
       [] kind = "archive" -> settled /\ ~pinned
  /\ relKind' = kind /\ relPc' = "stopping"
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc,
                 sendsLeft, wakesLeft, refused>>

\* stopSubagentsAndTasks stops what the agent left running, then release takes the lock and checks isBusy again.
\* Closing the session ends the CLI and whatever still runs inside it.
ReleaseLocks ==
  /\ relPc = "stopping" /\ lock = "free"
  /\ background' = FALSE
  /\ IF IsBusy
       THEN relPc' = "idle" /\ UNCHANGED lock
       ELSE relPc' = "cleaning" /\ lock' = "release"
  /\ UNCHANGED <<status, settled, pinned, listener, claim, sendPc, wakePc, relKind, sendsLeft, wakesLeft, refused>>

\* Settle.ts:64 stopProcesses: Terminals.closeThread, then Ports.closeThread, SIGKILL after 3 seconds.
ReleaseCleans ==
  /\ relPc = "cleaning"
  /\ listener' = FALSE /\ relPc' = "writing"
  /\ UNCHANGED <<status, settled, pinned, background, claim, lock, sendPc, wakePc, relKind,
                 sendsLeft, wakesLeft, refused>>

\* Threads.ts:822 settle, for the manual settle, writes settled: true, which clears pinned_at.
\* Threads.ts:830 settleIf, for the idle pass, rechecks the row under the worktree lock that Pin takes.
\* Threads.ts:795 archiveIf rechecks under that lock that the row is still settled and unpinned, and the archive
\* pass asks AgentRunner.isBusy there, so a send that claimed the thread during cleanup keeps it.
\* With "Remove the worktree when archiving" on, git removes the worktree between that check and the write. A
\* send that claims then still fails, because its turn was sent to that worktree (WorktreeLifecycle's
\* TurnRunsWhereSent). The model leaves worktree removal out, as the default setting does.
ReleaseWrites ==
  /\ relPc = "writing"
  /\ relPc' = "idle" /\ lock' = "free"
  /\ CASE relKind = "settle" /\ status = "idle" ->
            settled' = TRUE /\ pinned' = FALSE /\ UNCHANGED status
       [] relKind = "idleSettle" /\ status = "idle" /\ ~settled /\ ~pinned ->
            settled' = TRUE /\ UNCHANGED <<status, pinned>>
       [] relKind = "archive" /\ status = "idle" /\ settled /\ ~pinned /\ ~IsBusy ->
            status' = "archived" /\ UNCHANGED <<settled, pinned>>
       [] OTHER -> UNCHANGED <<status, settled, pinned>>
  /\ UNCHANGED <<background, listener, claim, sendPc, wakePc, relKind, sendsLeft, wakesLeft, refused>>

Next ==
  \/ SendClaims \/ SendFirstBlock \/ SendSecondBlock
  \/ TurnStartsListener \/ TurnStartsBackground \/ TurnEnds \/ WakeClaims \/ WakeAdopts
  \/ Pin \/ Unpin \/ Reopen
  \/ \E kind \in {"settle", "idleSettle", "archive"} : ReleaseStarts(kind)
  \/ ReleaseLocks \/ ReleaseCleans \/ ReleaseWrites

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ WF_vars(SendFirstBlock) /\ WF_vars(SendSecondBlock) /\ WF_vars(WakeAdopts) /\ WF_vars(TurnEnds)
  /\ WF_vars(ReleaseLocks) /\ WF_vars(ReleaseCleans) /\ WF_vars(ReleaseWrites)

TypeOK ==
  /\ status \in {"idle", "running", "archived"}
  /\ {settled, pinned, background, listener, refused} \subseteq BOOLEAN
  /\ claim \in {"none", "send", "wake", "turn"}
  /\ lock \in {"free", "release"}
  /\ sendPc \in {"idle", "first", "second"}
  /\ wakePc \in {"idle", "waiting"}
  /\ relPc \in {"idle", "stopping", "cleaning", "writing"}
  /\ relKind \in {"settle", "idleSettle", "archive"}
  /\ sendsLeft \in 0..MaxSends /\ wakesLeft \in 0..MaxWakes

\* Cleanup runs only while no turn holds the thread, so it never stops what a new turn started.
CleanupWaitsForTurns == relPc \in {"cleaning", "writing"} => status # "running"

\* A settled or archived thread has nothing of the agent's left running.
RestingIsQuiet == (settled \/ status = "archived") /\ relPc = "idle" => ~background /\ ~listener

\* The sweep never settles or archives a pinned thread.
PinnedIsNeverSettled == pinned => ~settled /\ status # "archived"

\* Only the developer drops a pin: Unpin, or settling by hand, which unpins on purpose. A pin that lands while
\* the idle pass cleans up survives it.
SweepKeepsPins == [][pinned /\ ~pinned' => Unpin \/ (relPc = "writing" /\ relKind = "settle")]_vars

\* The sweep yields to the developer: a message sent to a thread that was not archived is never refused
\* because the archive pass ran while it waited.
SendsAreNeverRefused == ~refused

\* Every send and every release finishes.
SendsFinish == sendPc # "idle" ~> sendPc = "idle"
ReleaseFinishes == relPc # "idle" ~> relPc = "idle"

=============================================================================
