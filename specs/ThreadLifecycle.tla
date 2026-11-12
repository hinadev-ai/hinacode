------------------------------ MODULE ThreadLifecycle ------------------------------
(* One thread's path through the Inbox: Draft, Working, Ready, Snoozed, Settled, Archived, Deleted.
   The phase is derived from the row, as inboxGroup does in src/shared/threadStatus.ts. The actors are the
   developer, the agent, GitHub, the clock and the merge sweep in src/main/services/AutoSettle.ts. *)
EXTENDS Naturals

VARIABLES
  status,       \* thread.status; running and awaiting_approval are busy per domain.ts
  settled,      \* thread.settled_at is set
  snoozed,      \* thread.snoozed_until is in the future
  pinned,       \* thread.pinned_at is set
  seen,         \* the developer read the latest turn, useUnseen in the renderer
  quiet,        \* seven days passed since lastActivity
  pr,           \* the linked pull request on GitHub
  mergeIsNewer, \* mergedAt is later than thread.work_started_at, the mergedSince check
  sweepPc,      \* settleIfDone: idle, or waiting on github.pullRequest
  sweepSaw,     \* whether the answer GitHub gave the sweep says merged
  keptOpen      \* history: the developer reopened this and no newer merge or settle has happened

vars == <<status, settled, snoozed, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

Statuses == {"draft", "idle", "running", "awaiting_approval", "limited", "interrupted", "archived", "deleted"}
Phases == {"draft", "working", "ready", "snoozed", "settled", "archived", "deleted"}

Busy == status \in {"running", "awaiting_approval"}

\* threadStatus.ts inboxGroup. The Quiet branch is computed, so settled_at stays null.
Quiet == status = "idle" /\ seen /\ quiet /\ pr # "open" /\ ~pinned

Phase ==
  CASE status = "deleted" -> "deleted"
    [] status = "archived" -> "archived"
    [] status = "draft" -> "draft"
    [] status = "awaiting_approval" -> "ready"
    [] snoozed -> "snoozed"
    [] status = "running" -> "working"
    [] settled \/ Quiet -> "settled"
    [] OTHER -> "ready"

\* The diagram. FlowIsLegal checks that no step leaves this set, and every edge is reached in the state graph.
Edges ==
  { <<"draft", "working">>, <<"draft", "deleted">>,
    <<"working", "ready">>, <<"working", "snoozed">>,
    <<"ready", "working">>, <<"ready", "snoozed">>, <<"ready", "settled">>, <<"ready", "archived">>, <<"ready", "deleted">>,
    <<"snoozed", "ready">>, <<"snoozed", "working">>, <<"snoozed", "settled">>, <<"snoozed", "archived">>, <<"snoozed", "deleted">>,
    <<"settled", "ready">>, <<"settled", "working">>, <<"settled", "archived">>, <<"settled", "deleted">>,
    <<"archived", "ready">>, <<"archived", "working">>, <<"archived", "deleted">> }

Init ==
  /\ status = "draft"
  /\ settled = FALSE /\ snoozed = FALSE /\ pinned = FALSE
  /\ seen = TRUE /\ quiet = FALSE
  /\ pr = "none" /\ mergeIsNewer = FALSE
  /\ sweepPc = "idle" /\ sweepSaw = FALSE
  /\ keptOpen = FALSE

\* AgentRunner send through Threads.write: startsWork clears settled_at and stamps work_started_at.
StartWork(from) ==
  /\ status \in from
  /\ status' = "running"
  /\ settled' = FALSE /\ snoozed' = FALSE
  /\ quiet' = FALSE
  /\ mergeIsNewer' = FALSE
  /\ UNCHANGED <<pinned, seen, pr, sweepPc, sweepSaw, keptOpen>>

\* Resume is a send too: AgentRunner.resume sends its prompt through the same path.
Send == StartWork({"draft", "idle", "limited", "interrupted"})

\* AgentRunner: a message to an archived thread unarchives it first.
SendToArchived == StartWork({"archived"})

\* Threads.remove. A running thread refuses from the row menu; a draft is discarded.
Delete ==
  /\ ~Busy /\ status # "deleted"
  /\ status' = "deleted"
  /\ UNCHANGED <<settled, snoozed, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

TurnEnds ==
  /\ status = "running"
  /\ status' = "idle" /\ seen' \in BOOLEAN /\ snoozed' = FALSE
  /\ UNCHANGED <<settled, pinned, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

TurnLimited ==
  /\ Busy
  /\ status' = "limited" /\ snoozed' = FALSE
  /\ UNCHANGED <<settled, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

\* HinaCode stops mid-turn. A hard kill leaves the row busy and Threads.resetInterrupted rewrites it at the next
\* start; a graceful quit interrupts the turn fiber, and its finish writes the same row. Nothing starts it again.
Restart ==
  /\ Busy
  /\ status' = "interrupted" /\ snoozed' = FALSE
  /\ UNCHANGED <<settled, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

AskApproval ==
  /\ status = "running"
  /\ status' = "awaiting_approval" /\ snoozed' = FALSE
  /\ UNCHANGED <<settled, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

ResolveApproval ==
  /\ status = "awaiting_approval"
  /\ status' = "running"
  /\ UNCHANGED <<settled, snoozed, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

Read ==
  /\ ~seen
  /\ seen' = TRUE
  /\ UNCHANGED <<status, settled, snoozed, pinned, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

\* Threads.settle. Also clears the pin and the snooze, and refuses a busy thread.
SettleByHand ==
  /\ status \in {"idle", "limited", "interrupted"} /\ ~settled
  /\ settled' = TRUE /\ snoozed' = FALSE /\ pinned' = FALSE /\ keptOpen' = FALSE
  /\ UNCHANGED <<status, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw>>

\* Threads.unsettle. Restarts the quiet clock and stamps work_started_at, so an old merge cannot settle it again.
Reopen ==
  /\ Phase = "settled"
  /\ settled' = FALSE /\ quiet' = FALSE /\ mergeIsNewer' = FALSE /\ keptOpen' = TRUE
  /\ UNCHANGED <<status, snoozed, pinned, seen, pr, sweepPc, sweepSaw>>

\* Threads.archive. A busy thread refuses with ThreadBusyError.
Archive ==
  /\ status \in {"idle", "limited", "interrupted"}
  /\ status' = "archived"
  /\ UNCHANGED <<settled, snoozed, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

\* Threads.unarchive goes through write, which clears settled_at and bumps updated_at.
Unarchive ==
  /\ status = "archived"
  /\ status' = "idle" /\ settled' = FALSE /\ snoozed' = FALSE /\ quiet' = FALSE /\ mergeIsNewer' = FALSE
  /\ UNCHANGED <<pinned, seen, pr, sweepPc, sweepSaw, keptOpen>>

\* The row's Snooze stays enabled during a turn. Threads.write clears snoozed_until on the next status change.
Snooze ==
  /\ Phase \in {"ready", "working"} /\ status \in {"idle", "limited", "interrupted", "running"}
  /\ snoozed' = TRUE
  /\ UNCHANGED <<status, settled, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

\* The timer. lastActivity becomes snoozedUntil, so the quiet clock restarts.
Wake ==
  /\ snoozed
  /\ snoozed' = FALSE /\ quiet' = FALSE
  /\ UNCHANGED <<status, settled, pinned, seen, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

\* The row's Unsnooze clears the time without touching updated_at, so a quiet thread stays quiet.
Unsnooze ==
  /\ snoozed
  /\ snoozed' = FALSE
  /\ UNCHANGED <<status, settled, pinned, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

\* Threads.write: pinning a settled thread brings it back.
Pin ==
  /\ status \in {"idle", "limited", "interrupted", "running", "awaiting_approval"} /\ ~pinned
  /\ pinned' = TRUE /\ settled' = FALSE
  /\ UNCHANGED <<status, snoozed, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

Unpin ==
  /\ pinned
  /\ pinned' = FALSE
  /\ UNCHANGED <<status, settled, snoozed, seen, quiet, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

\* Seven days pass. selectInboxThreads keeps a snoozed thread out, and a busy thread has no resting clock.
TimePasses ==
  /\ status = "idle" /\ ~quiet /\ ~snoozed
  /\ quiet' = TRUE
  /\ UNCHANGED <<status, settled, snoozed, pinned, seen, pr, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

OpenPullRequest ==
  /\ pr = "none" /\ status \notin {"draft", "deleted"}
  /\ pr' = "open"
  /\ UNCHANGED <<status, settled, snoozed, pinned, seen, quiet, mergeIsNewer, sweepPc, sweepSaw, keptOpen>>

Merge ==
  /\ pr = "open"
  /\ pr' = "merged" /\ mergeIsNewer' = TRUE /\ keptOpen' = FALSE
  /\ UNCHANGED <<status, settled, snoozed, pinned, seen, quiet, sweepPc, sweepSaw>>

CanAutoSettle == status \in {"idle", "limited", "interrupted"} /\ ~settled /\ ~pinned

\* AutoSettle.ts settleIfDone: the first canAutoSettle, then the await on github.pullRequest.
SweepAsks ==
  /\ sweepPc = "idle" /\ pr # "none" /\ CanAutoSettle
  /\ sweepPc' = "asking" /\ sweepSaw' = (pr = "merged")
  /\ UNCHANGED <<status, settled, snoozed, pinned, seen, quiet, pr, mergeIsNewer, keptOpen>>

\* AutoSettle.ts settleIfDone: mergedSince and the second canAutoSettle read the row after GitHub answered.
\* Threads.settleMerged rechecks under the worktree lock and again after removing the worktree, right before
\* its synchronous write, so the check and the write are one action. Reopen and Pin take no lock.
SweepDecides ==
  /\ sweepPc = "asking"
  /\ sweepPc' = "idle" /\ sweepSaw' = FALSE
  /\ IF sweepSaw /\ mergeIsNewer /\ CanAutoSettle
       THEN settled' = TRUE /\ snoozed' = FALSE
       ELSE UNCHANGED <<settled, snoozed>>
  /\ UNCHANGED <<status, pinned, seen, quiet, pr, mergeIsNewer, keptOpen>>

Next ==
  \/ Send \/ SendToArchived \/ Delete
  \/ TurnEnds \/ TurnLimited \/ Restart \/ AskApproval \/ ResolveApproval \/ Read
  \/ SettleByHand \/ Reopen \/ Archive \/ Unarchive
  \/ Snooze \/ Wake \/ Unsnooze \/ Pin \/ Unpin \/ TimePasses
  \/ OpenPullRequest \/ Merge \/ SweepAsks \/ SweepDecides

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  \* An agent can keep asking for approvals, but it does not do so forever. Weak fairness would not say that,
  \* because each question disables TurnEnds.
  /\ SF_vars(TurnEnds)
  /\ WF_vars(ResolveApproval)
  /\ WF_vars(SweepDecides)
  /\ WF_vars(Wake)

TypeOK ==
  /\ status \in Statuses
  /\ {settled, snoozed, pinned, seen, quiet, mergeIsNewer, sweepSaw, keptOpen} \subseteq BOOLEAN
  /\ pr \in {"none", "open", "merged"}
  /\ sweepPc \in {"idle", "asking"}
  /\ Phase \in Phases

\* A working thread is never Settled, and a question ends any snooze.
BusyIsNeverParked == (Busy => ~settled) /\ (status = "awaiting_approval" => ~snoozed)

\* A question and a usage limit stay in Ready unless the developer settled the limited thread by hand.
QuestionsStayVisible == status = "awaiting_approval" => Phase = "ready"

\* Pinning means keep this here: nothing settles a pinned thread, and settling by hand removes the pin.
PinnedIsNeverSettled == pinned => ~settled

\* After Reopen, a sweep already waiting on GitHub cannot settle the thread for the merge it saw earlier.
ReopenSticks == keptOpen => ~settled

\* A draft has no turn to rest from.
DraftsHaveNoHistory == status = "draft" => ~settled /\ ~snoozed /\ ~quiet

\* Every Phase change is an edge of the diagram.
FlowIsLegal == [][(<<Phase, Phase'>> \in Edges) \/ (Phase = Phase')]_vars

DeletedIsFinal == [][status = "deleted" => status' = "deleted"]_vars

\* Every turn hands back to the developer, whatever the sweep and the other actors do.
TurnsHandBack == Busy ~> ~Busy

SweepFinishes == sweepPc = "asking" ~> sweepPc = "idle"

=============================================================================
