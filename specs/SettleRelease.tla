------------------------------ MODULE SettleRelease ------------------------------
(* Settling and auto-archiving one thread while the developer and the agent keep using it.
   The manual settle and the sweep's merge, idle and archive passes in src/main/services/Settle.ts hand their
   cleanup to AgentRunner.release (src/main/services/AgentRunner.ts), which runs it under the thread's lock once no
   turn holds the thread. Racing them: a send from the composer (rpc.ts threads.send, AgentRunner.sendWhen and
   startTurn), the agent waking itself for a finished background task (AgentRunner.startWake), the pull request
   merging, and Pin and Reopen (Threads.update, Threads.unsettle), which take the worktree lock and not the
   thread's. *)
EXTENDS Naturals

CONSTANTS MaxSends, MaxWakes, MaxMerges

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
  relKind,    \* who runs release: a manual settle, or the sweep's merge, idle or archive pass
  merged,     \* the thread's own pull request merged after thread.work_started_at, so mergedSince holds
  mergePc,    \* settleIfDone: idle, waiting on SourceControl.pullRequest, on the port scan, on the worktree lock,
              \* or done and waiting to release
  sawMerged,  \* settleIfDone's found: the pull request it fetched merged after the work_started_at it now reads
  sendsLeft, wakesLeft, mergesLeft,
  refused,    \* history: a send to a thread that was not archived when the developer sent it was refused
  keptOpen    \* history: the developer reopened the thread and no newer merge or settle has happened since

vars == <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
          merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

IsBusy == claim # "none"

\* Settle.ts canAutoSettle.
CanAutoSettle == status = "idle" /\ ~settled /\ ~pinned

Init ==
  /\ status = "idle" /\ settled = FALSE /\ pinned = FALSE
  /\ background = FALSE /\ listener = FALSE
  /\ claim = "none" /\ lock = "free"
  /\ sendPc = "idle" /\ wakePc = "idle" /\ relPc = "idle" /\ relKind = "settle"
  /\ merged = FALSE /\ mergePc = "idle" /\ sawMerged = FALSE
  /\ sendsLeft = MaxSends /\ wakesLeft = MaxWakes /\ mergesLeft = MaxMerges
  /\ refused = FALSE /\ keptOpen = FALSE

\* Threads.ts write stamps work_started_at when a thread starts work, is unarchived or is reopened. A merge the
\* sweep already fetched is older than that stamp, so mergedSince no longer holds for it.
StampsWorkStarted == merged' = FALSE /\ sawMerged' = FALSE

---------------------------------------------------------------------------------------------------------------
\* The developer's send.

\* rpc.ts threads.send unarchives an archived thread, then AgentRunner.ts sendWhen claims busyThreads without
\* the lock. The composer steers rather than sends while a turn runs, so the claim never fails here.
SendClaims ==
  /\ sendsLeft > 0 /\ sendPc = "idle" /\ ~IsBusy
  /\ sendsLeft' = sendsLeft - 1
  /\ claim' = "send" /\ sendPc' = "first"
  /\ IF status = "archived"
       THEN status' = "idle" /\ settled' = FALSE /\ StampsWorkStarted
       ELSE UNCHANGED <<status, settled, merged, sawMerged>>
  /\ UNCHANGED <<pinned, background, listener, lock, wakePc, relPc, relKind, mergePc, wakesLeft, mergesLeft, refused,
                 keptOpen>>

\* AgentRunner.ts startTurn's first exclusive block promotes a draft and prepares the workspace.
SendFirstBlock ==
  /\ sendPc = "first" /\ lock = "free"
  /\ sendPc' = "second"
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, wakePc, relPc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* AgentRunner.ts startTurn's second exclusive block refuses an archived thread, or marks it running.
\* Threads.ts write clears settled_at when a turn starts work.
SendSecondBlock ==
  /\ sendPc = "second" /\ lock = "free"
  /\ sendPc' = "idle"
  /\ IF status = "archived"
       THEN /\ claim' = "none" /\ refused' = TRUE
            /\ UNCHANGED <<status, settled, merged, sawMerged>>
       ELSE /\ claim' = "turn" /\ status' = "running" /\ settled' = FALSE /\ StampsWorkStarted
            /\ UNCHANGED refused
  /\ UNCHANGED <<pinned, background, listener, lock, wakePc, relPc, relKind, mergePc, sendsLeft, wakesLeft, mergesLeft,
                 keptOpen>>

---------------------------------------------------------------------------------------------------------------
\* The agent.

\* A turn starts a dev server, or a sub-agent or background task that outlives the turn.
TurnStartsListener ==
  /\ status = "running" /\ ~listener
  /\ listener' = TRUE
  /\ UNCHANGED <<status, settled, pinned, background, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

TurnStartsBackground ==
  /\ status = "running" /\ ~background
  /\ background' = TRUE
  /\ UNCHANGED <<status, settled, pinned, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* AgentRunner.ts makeTurn finish, under the thread lock, sets the thread idle and drops the claim.
TurnEnds ==
  /\ status = "running" /\ lock = "free"
  /\ status' = "idle" /\ claim' = "none"
  /\ UNCHANGED <<settled, pinned, background, listener, lock, sendPc, wakePc, relPc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* AgentRunner.ts startWake: a finished background task wakes the agent. It waits out busyThreads and claims.
WakeClaims ==
  /\ wakesLeft > 0 /\ background /\ wakePc = "idle" /\ ~IsBusy
  /\ wakesLeft' = wakesLeft - 1
  /\ claim' = "wake" /\ wakePc' = "waiting" /\ background' = FALSE
  /\ UNCHANGED <<status, settled, pinned, listener, lock, sendPc, relPc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, mergesLeft, refused, keptOpen>>

\* Under both locks, an archived thread drops the wake, and any other starts a turn.
WakeAdopts ==
  /\ wakePc = "waiting" /\ lock = "free"
  /\ wakePc' = "idle"
  /\ IF status = "archived"
       THEN claim' = "none" /\ UNCHANGED <<status, settled, merged, sawMerged>>
       ELSE claim' = "turn" /\ status' = "running" /\ settled' = FALSE /\ StampsWorkStarted
  /\ UNCHANGED <<pinned, background, listener, lock, sendPc, relPc, relKind, mergePc, sendsLeft, wakesLeft, mergesLeft,
                 refused, keptOpen>>

---------------------------------------------------------------------------------------------------------------
\* The developer's row actions, each one write under the worktree lock, and GitHub.

\* Threads.ts update with pinned: true, which clears settled_at.
Pin ==
  /\ status # "archived" /\ ~pinned
  /\ pinned' = TRUE /\ settled' = FALSE
  /\ UNCHANGED <<status, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

Unpin ==
  /\ pinned
  /\ pinned' = FALSE
  /\ UNCHANGED <<status, settled, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* Threads.ts unsettle.
Reopen ==
  /\ settled
  /\ settled' = FALSE /\ keptOpen' = TRUE /\ StampsWorkStarted
  /\ UNCHANGED <<status, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 mergePc, sendsLeft, wakesLeft, mergesLeft, refused>>

\* The thread's own pull request merges.
Merge ==
  /\ mergesLeft > 0 /\ ~merged /\ status # "archived"
  /\ mergesLeft' = mergesLeft - 1
  /\ merged' = TRUE /\ keptOpen' = FALSE
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 mergePc, sawMerged, sendsLeft, wakesLeft, refused>>

---------------------------------------------------------------------------------------------------------------
\* The sweep's merge pass, Settle.ts settleIfDone. Unlike the other passes it writes the row first and releases
\* after, so its cleanup only closes terminals.

\* It reads the row, checks canAutoSettle and hasAgentWork, then waits on SourceControl.pullRequest.
MergeAsks ==
  /\ mergePc = "idle" /\ CanAutoSettle /\ ~background
  /\ mergePc' = "fetching"
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* The host answers. A pull request that is not finished ends the pass, and otherwise it waits on hasListeningPort.
MergeFetched ==
  /\ mergePc = "fetching"
  /\ mergePc' = IF merged THEN "scanning" ELSE "idle"
  /\ sawMerged' = merged
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* A listening port ends the pass, and otherwise Threads.settleMerged waits for the worktree lock.
MergeScanned ==
  /\ mergePc = "scanning"
  /\ mergePc' = IF listener THEN "idle" ELSE "locking"
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* Threads.ts settleMerged rereads the row and work_started_at under the worktree lock that Pin and Reopen take,
\* and checks canAutoSettle and mergedSince against what it fetched. It does not ask hasAgentWork again. With
\* "Remove the worktree when archiving" on, it removes the worktree and checks again, which the model leaves out.
MergeSettles ==
  /\ mergePc = "locking"
  /\ IF CanAutoSettle /\ sawMerged
       THEN settled' = TRUE /\ mergePc' = "releasing"
       ELSE UNCHANGED settled /\ mergePc' = "idle"
  /\ UNCHANGED <<status, pinned, background, listener, claim, lock, sendPc, wakePc, relPc, relKind,
                 merged, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* Then it calls release with Terminals.closeThread. release returns at once while isBusy. The model runs one
\* release at a time, so this waits for a manual settle already in flight, and LiveSpec keeps that from starving it.
MergeReleases ==
  /\ mergePc = "releasing" /\ relPc = "idle"
  /\ mergePc' = "idle"
  /\ IF IsBusy
       THEN UNCHANGED <<relPc, relKind>>
       ELSE relPc' = "stopping" /\ relKind' = "merge"
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc,
                 merged, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

---------------------------------------------------------------------------------------------------------------
\* Settle and archive, through AgentRunner.ts release.

\* Settle.ts settle checks the row is not busy. Settle.ts settleIfIdle rereads the row after the host and the port
\* scan answer, and needs no pin, no settle, no agent work and no listener. Settle.ts archiveIfSettledLong needs a
\* settled, unpinned row. The sweep runs its passes one after another, so the idle and archive passes wait for the
\* merge pass. Then release checks isBusy before its first await.
ReleaseStarts(kind) ==
  /\ relPc = "idle" /\ status = "idle" /\ ~IsBusy
  /\ kind # "settle" => mergePc = "idle"
  /\ CASE kind = "settle" -> ~settled
       [] kind = "idleSettle" -> ~settled /\ ~pinned /\ ~background /\ ~listener
       [] kind = "archive" -> settled /\ ~pinned
  /\ relKind' = kind /\ relPc' = "stopping"
  /\ UNCHANGED <<status, settled, pinned, background, listener, claim, lock, sendPc, wakePc,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* stopSubagentsAndTasks stops what the agent left running, then release takes the lock and checks isBusy again.
\* closeProviderSession ends the CLI and whatever still runs inside it.
ReleaseLocks ==
  /\ relPc = "stopping" /\ lock = "free"
  /\ background' = FALSE
  /\ IF IsBusy
       THEN relPc' = "idle" /\ UNCHANGED lock
       ELSE relPc' = "cleaning" /\ lock' = "release"
  /\ UNCHANGED <<status, settled, pinned, listener, claim, sendPc, wakePc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* Settle.ts stopProcesses: Terminals.closeThread, then Ports.closeThread, SIGKILL after 3 seconds. The merge pass
\* closes terminals only, so a listener outside them survives it.
ReleaseCleans ==
  /\ relPc = "cleaning"
  /\ listener' = (relKind = "merge" /\ listener)
  /\ relPc' = "writing"
  /\ UNCHANGED <<status, settled, pinned, background, claim, lock, sendPc, wakePc, relKind,
                 merged, mergePc, sawMerged, sendsLeft, wakesLeft, mergesLeft, refused, keptOpen>>

\* Threads.ts settle, for the manual settle, writes settled: true, which clears pinned_at.
\* Threads.ts settleIf, for the idle pass, rechecks the row under the worktree lock that Pin takes.
\* Threads.ts archiveIf rechecks under that lock that the row is still settled and unpinned, and the archive
\* pass asks AgentRunner.isBusy there, so a send that claimed the thread during cleanup keeps it.
\* With "Remove the worktree when archiving" on, git removes the worktree between that check and the write. A
\* send that claims then still fails, because its turn was sent to that worktree (WorktreeLifecycle's
\* TurnRunsWhereSent). The model leaves worktree removal out, as the default setting does.
\* The merge pass wrote the row before release and writes nothing here.
ReleaseWrites ==
  /\ relPc = "writing"
  /\ relPc' = "idle" /\ lock' = "free"
  /\ CASE relKind = "settle" /\ status = "idle" ->
            settled' = TRUE /\ pinned' = FALSE /\ keptOpen' = FALSE /\ UNCHANGED status
       [] relKind = "idleSettle" /\ status = "idle" /\ ~settled /\ ~pinned ->
            settled' = TRUE /\ keptOpen' = FALSE /\ UNCHANGED <<status, pinned>>
       [] relKind = "archive" /\ status = "idle" /\ settled /\ ~pinned /\ ~IsBusy ->
            status' = "archived" /\ UNCHANGED <<settled, pinned, keptOpen>>
       [] OTHER -> UNCHANGED <<status, settled, pinned, keptOpen>>
  /\ UNCHANGED <<background, listener, claim, sendPc, wakePc, relKind, merged, mergePc, sawMerged,
                 sendsLeft, wakesLeft, mergesLeft, refused>>

Next ==
  \/ SendClaims \/ SendFirstBlock \/ SendSecondBlock
  \/ TurnStartsListener \/ TurnStartsBackground \/ TurnEnds \/ WakeClaims \/ WakeAdopts
  \/ Pin \/ Unpin \/ Reopen \/ Merge
  \/ MergeAsks \/ MergeFetched \/ MergeScanned \/ MergeSettles \/ MergeReleases
  \/ \E kind \in {"settle", "idleSettle", "archive"} : ReleaseStarts(kind)
  \/ ReleaseLocks \/ ReleaseCleans \/ ReleaseWrites

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ WF_vars(SendFirstBlock) /\ WF_vars(SendSecondBlock) /\ WF_vars(WakeAdopts) /\ WF_vars(TurnEnds)
  /\ WF_vars(ReleaseLocks) /\ WF_vars(ReleaseCleans) /\ WF_vars(ReleaseWrites)
  /\ WF_vars(MergeFetched) /\ WF_vars(MergeScanned) /\ WF_vars(MergeSettles) /\ SF_vars(MergeReleases)

TypeOK ==
  /\ status \in {"idle", "running", "archived"}
  /\ {settled, pinned, background, listener, merged, sawMerged, refused, keptOpen} \subseteq BOOLEAN
  /\ claim \in {"none", "send", "wake", "turn"}
  /\ lock \in {"free", "release"}
  /\ sendPc \in {"idle", "first", "second"}
  /\ wakePc \in {"idle", "waiting"}
  /\ relPc \in {"idle", "stopping", "cleaning", "writing"}
  /\ relKind \in {"settle", "merge", "idleSettle", "archive"}
  /\ mergePc \in {"idle", "fetching", "scanning", "locking", "releasing"}
  /\ sendsLeft \in 0..MaxSends /\ wakesLeft \in 0..MaxWakes /\ mergesLeft \in 0..MaxMerges

\* Cleanup runs only while no turn holds the thread, so it never stops what a new turn started.
CleanupWaitsForTurns == relPc \in {"cleaning", "writing"} => status # "running"

\* A turn clears settled_at when it starts, and nothing settles a running thread.
BusyIsNeverSettled == status = "running" => ~settled

\* A settled or archived thread has nothing of the agent's left running.
RestingIsQuiet == (settled \/ status = "archived") /\ relPc = "idle" /\ mergePc = "idle" => ~background /\ ~listener

\* The sweep never settles or archives a pinned thread.
PinnedIsNeverSettled == pinned => ~settled /\ status # "archived"

\* After Reopen, a merge pass already waiting on the host cannot settle the thread for the merge it fetched.
ReopenSticks == keptOpen => ~settled

\* Only the developer drops a pin: Unpin, or settling by hand, which unpins on purpose. A pin that lands while
\* the idle pass cleans up survives it.
SweepKeepsPins == [][pinned /\ ~pinned' => Unpin \/ (relPc = "writing" /\ relKind = "settle")]_vars

\* The sweep yields to the developer: a message sent to a thread that was not archived is never refused
\* because the archive pass ran while it waited.
SendsAreNeverRefused == ~refused

\* Every send, release and merge pass finishes.
SendsFinish == sendPc # "idle" ~> sendPc = "idle"
ReleaseFinishes == relPc # "idle" ~> relPc = "idle"
MergePassFinishes == mergePc # "idle" ~> mergePc = "idle"

=============================================================================
