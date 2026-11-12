------------------------------ MODULE ThreadLifecycle ------------------------------
(* One thread's place in the Inbox: Draft, Working, Ready, Snoozed, Settled, Archived, Deleted, the chart in
   docs/arch.md. The phase is derived from the row, as the sidebar does with selectSnoozedThreads in
   src/renderer/stores/threads.ts and inboxGroup in src/shared/threadStatus.ts. The actors are the developer, the
   agent and the sweep in src/main/services/Settle.ts. Each of the sweep's passes is one step here, and
   SettleRelease.tla models them step by step against sends, wakes and AgentRunner.release. *)
EXTENDS Naturals

VARIABLES
  status,  \* thread.status; running and awaiting_approval are busy per domain.ts isThreadBusy
  settled, \* thread.settled_at is set
  snoozed, \* thread.snoozed_until is in the future
  pinned   \* thread.pinned_at is set

vars == <<status, settled, snoozed, pinned>>

Statuses == {"draft", "idle", "running", "awaiting_approval", "limited", "archived", "deleted"}
Phases == {"draft", "working", "ready", "snoozed", "settled", "archived", "deleted"}

Busy == status \in {"running", "awaiting_approval"}

\* Sidebar.tsx lists drafts and snoozed threads in their own sections, and inboxGroup splits the rest by rowState
\* and settled_at. A working row stays in Ready, dimmed, and the chart calls it Working.
Phase ==
  CASE status = "deleted" -> "deleted"
    [] status = "archived" -> "archived"
    [] status = "draft" -> "draft"
    [] status = "awaiting_approval" -> "ready"
    [] snoozed -> "snoozed"
    [] status = "running" -> "working"
    [] settled -> "settled"
    [] OTHER -> "ready"

\* The diagram. FlowIsLegal checks that no step leaves this set.
Edges ==
  { <<"draft", "working">>, <<"draft", "deleted">>,
    <<"working", "ready">>, <<"working", "snoozed">>,
    <<"ready", "working">>, <<"ready", "snoozed">>, <<"ready", "settled">>, <<"ready", "archived">>,
    <<"ready", "deleted">>,
    <<"snoozed", "ready">>, <<"snoozed", "working">>, <<"snoozed", "settled">>, <<"snoozed", "archived">>,
    <<"snoozed", "deleted">>,
    <<"settled", "ready">>, <<"settled", "working">>, <<"settled", "archived">>, <<"settled", "deleted">>,
    <<"archived", "ready">>, <<"archived", "working">>, <<"archived", "deleted">> }

Init == status = "draft" /\ settled = FALSE /\ snoozed = FALSE /\ pinned = FALSE

\* AgentRunner.ts startTurn through Threads.ts write: startsWork clears settled_at, and the status change clears
\* snoozed_until.
StartWork(from) ==
  /\ status \in from
  /\ status' = "running" /\ settled' = FALSE /\ snoozed' = FALSE
  /\ UNCHANGED pinned

Send == StartWork({"draft", "idle", "limited"})

\* rpc.ts threads.send unarchives an archived thread first.
SendToArchived == StartWork({"archived"})

\* Threads.ts remove. A running thread refuses from the row menu; a draft is discarded.
Delete ==
  /\ ~Busy /\ status # "deleted"
  /\ status' = "deleted"
  /\ UNCHANGED <<settled, snoozed, pinned>>

TurnEnds ==
  /\ status = "running"
  /\ status' = "idle" /\ snoozed' = FALSE
  /\ UNCHANGED <<settled, pinned>>

TurnLimited ==
  /\ Busy
  /\ status' = "limited" /\ snoozed' = FALSE
  /\ UNCHANGED <<settled, pinned>>

AskApproval ==
  /\ status = "running"
  /\ status' = "awaiting_approval" /\ snoozed' = FALSE
  /\ UNCHANGED <<settled, pinned>>

ResolveApproval ==
  /\ status = "awaiting_approval"
  /\ status' = "running"
  /\ UNCHANGED <<settled, snoozed, pinned>>

\* Settle.ts settle through Threads.ts settle, which refuses a busy thread. Writing settled: true also clears the
\* pin and the snooze.
SettleByHand ==
  /\ status \in {"idle", "limited"} /\ ~settled
  /\ settled' = TRUE /\ snoozed' = FALSE /\ pinned' = FALSE
  /\ UNCHANGED status

\* Settle.ts settleIfDone (Threads.ts settleMerged) and settleIfIdle (Threads.ts settleIf) need canAutoSettle.
SweepSettles ==
  /\ status \in {"idle", "limited"} /\ ~settled /\ ~pinned
  /\ settled' = TRUE /\ snoozed' = FALSE
  /\ UNCHANGED <<status, pinned>>

\* Threads.ts unsettle.
Reopen ==
  /\ Phase = "settled"
  /\ settled' = FALSE
  /\ UNCHANGED <<status, snoozed, pinned>>

\* Threads.ts archiveIf, for the row's Archive and Settle.ts archiveIfSettledLong. A busy thread refuses with
\* ThreadBusyError.
Archive ==
  /\ status \in {"idle", "limited"}
  /\ status' = "archived"
  /\ UNCHANGED <<settled, snoozed, pinned>>

\* Threads.ts unarchive clears settled_at and snoozed_until.
Unarchive ==
  /\ status = "archived"
  /\ status' = "idle" /\ settled' = FALSE /\ snoozed' = FALSE
  /\ UNCHANGED pinned

\* The row's Snooze stays enabled during a turn. Threads.ts write clears snoozed_until on the next status change.
Snooze ==
  /\ Phase \in {"ready", "working"} /\ status \in {"idle", "limited", "running"}
  /\ snoozed' = TRUE
  /\ UNCHANGED <<status, settled, pinned>>

\* The snooze time passes, or the developer unsnoozes.
Wake ==
  /\ snoozed
  /\ snoozed' = FALSE
  /\ UNCHANGED <<status, settled, pinned>>

\* Threads.ts write: pinning a settled thread brings it back.
Pin ==
  /\ status \in {"idle", "limited", "running", "awaiting_approval"} /\ ~pinned
  /\ pinned' = TRUE /\ settled' = FALSE
  /\ UNCHANGED <<status, snoozed>>

Unpin ==
  /\ pinned
  /\ pinned' = FALSE
  /\ UNCHANGED <<status, settled, snoozed>>

Next ==
  \/ Send \/ SendToArchived \/ Delete
  \/ TurnEnds \/ TurnLimited \/ AskApproval \/ ResolveApproval
  \/ SettleByHand \/ SweepSettles \/ Reopen \/ Archive \/ Unarchive
  \/ Snooze \/ Wake \/ Pin \/ Unpin

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  \* An agent can keep asking for approvals, but it does not do so forever. Weak fairness would not say that,
  \* because each question disables TurnEnds.
  /\ SF_vars(TurnEnds)
  /\ WF_vars(ResolveApproval)

TypeOK ==
  /\ status \in Statuses
  /\ {settled, snoozed, pinned} \subseteq BOOLEAN
  /\ Phase \in Phases

\* A working thread is never Settled, and a question ends any snooze.
BusyIsNeverParked == (Busy => ~settled) /\ (status = "awaiting_approval" => ~snoozed)

\* A question and a usage limit stay in Ready unless the developer settled the limited thread by hand.
QuestionsStayVisible == status = "awaiting_approval" => Phase = "ready"

\* Pinning means keep this here: nothing settles a pinned thread, and settling by hand removes the pin.
PinnedIsNeverSettled == pinned => ~settled

\* A draft has no turn to rest from.
DraftsHaveNoHistory == status = "draft" => ~settled /\ ~snoozed

\* Every Phase change is an edge of the diagram.
FlowIsLegal == [][(<<Phase, Phase'>> \in Edges) \/ (Phase = Phase')]_vars

DeletedIsFinal == [][status = "deleted" => status' = "deleted"]_vars

\* Every turn hands back to the developer, whatever the sweep and the other actors do.
TurnsHandBack == Busy ~> ~Busy

=============================================================================
