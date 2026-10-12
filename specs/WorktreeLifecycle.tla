------------------------------ MODULE WorktreeLifecycle ------------------------------
(* The worktree lifecycle in src/main/services/Worktrees.ts and its race with agent turns in
   src/main/services/AgentRunner.ts, for one project and one branch. *)
\* The model only includes threads that own a worktree, one each, so thread t's row and checkout are t.
\* A checkout directory and its `git worktree` registration are one thing: `remove --force` deletes both.
\* `awaiting_approval` is folded into `running`; both are busy per domain.ts:79.
EXTENDS Naturals, FiniteSets

CONSTANTS Threads, Branch, MaxRemovals

Rows == Threads
Root == "root"
Live == {"preparing", "ready", "failed"}
\* Bound on deletion fibers ever started, so retries after a failed deletion stay finite.
Fibers == 1..MaxRemovals

VARIABLES
  worktreeStatus,
  dirs,          \* checkout directories on disk
  branches,      \* git branches that exist
  lock,          \* Worktrees.ts:148, the thread whose create holds it, or "free"
  removals,      \* Worktrees.ts:237, the one key's deletion fiber, 0 when absent
  deletions,     \* deletion fibers forked by remove
  createPc, awaited, newBranch, setupRunning,
  threadStatus, busyThreads, turnPc, cwd,
  sentWhileLive, \* history: was the thread's row live when send was called
  settlePc

wtVars == <<worktreeStatus, dirs, branches, lock, removals, deletions>>
createVars == <<createPc, awaited, newBranch, setupRunning>>
turnVars == <<threadStatus, busyThreads, turnPc, cwd, sentWhileLive, settlePc>>
vars == <<wtVars, createVars, turnVars>>

DeletionPcs == {"unused", "list", "remove", "prune", "branchCheck", "branchD", "restore", "cleanup", "done"}

TypeOK ==
  /\ worktreeStatus \in [Rows -> Live \cup {"none", "removed"}]
  /\ dirs \subseteq Rows /\ branches \subseteq {Branch}
  /\ lock \in Threads \cup {"free"} /\ removals \in Fibers \cup {0}
  /\ deletions \in [Fibers -> [row : Rows \cup {"none"}, pc : DeletionPcs, old : Live \cup {"none"}]]
  /\ threadStatus \in [Threads -> {"none", "idle", "running", "settled"}]
  /\ busyThreads \subseteq Threads
  /\ turnPc \in [Threads -> {"none", "start", "running", "completed"}]
  /\ cwd \in [Threads -> Rows \cup {Root, "none"}]

Init ==
  /\ worktreeStatus = [r \in Rows |-> "none"]
  /\ dirs = {}
  /\ branches \in SUBSET {Branch}
  /\ lock = "free"
  /\ removals = 0
  /\ deletions = [f \in Fibers |-> [row |-> "none", pc |-> "unused", old |-> "none"]]
  /\ createPc = [t \in Threads |-> "idle"]
  /\ awaited = [t \in Threads |-> 0]
  /\ newBranch = [t \in Threads |-> FALSE]
  /\ setupRunning = {}
  /\ threadStatus = [t \in Threads |-> "none"]
  /\ busyThreads = {}
  /\ turnPc = [t \in Threads |-> "none"]
  /\ cwd = [t \in Threads |-> "none"]
  /\ sentWhileLive = [t \in Threads |-> FALSE]
  /\ settlePc = [t \in Threads |-> "none"]

SetPc(t, pc) == createPc' = [createPc EXCEPT ![t] = pc]
FailCreate(t) == lock' = "free" /\ SetPc(t, "idle")

\* Worktrees.ts:254-256 acquire the lock, projects.get, removals.get
CreateBegin(t) ==
  /\ threadStatus[t] = "none" /\ createPc[t] = "idle" /\ lock = "free"
  /\ lock' = t /\ awaited' = [awaited EXCEPT ![t] = removals] /\ SetPc(t, "findLive")
  /\ UNCHANGED <<worktreeStatus, dirs, branches, removals, deletions, newBranch, setupRunning, turnVars>>

\* Worktrees.ts:257-263 Fiber.await(removal), then findLive
CreateFindLive(t) ==
  /\ createPc[t] = "findLive"
  /\ IF awaited[t] = 0 THEN TRUE ELSE deletions[awaited[t]].pc = "done"
  /\ IF \E r \in Rows : worktreeStatus[r] \in Live THEN FailCreate(t) ELSE lock' = lock /\ SetPc(t, "branchExists")
  /\ UNCHANGED <<worktreeStatus, dirs, branches, removals, deletions, awaited, newBranch, setupRunning, turnVars>>

\* Worktrees.ts:266-269 findOrphan, then branchExists. An orphan only comes from a crash between
\* `git worktree add` and the insert, which is not modeled, so findOrphan always returns none.
CreateBranchExists(t) ==
  /\ createPc[t] = "branchExists"
  /\ newBranch' = [newBranch EXCEPT ![t] = Branch \notin branches] /\ SetPc(t, "add")
  /\ UNCHANGED <<wtVars, awaited, setupRunning, turnVars>>

\* Worktrees.ts:270-272 git worktree add. Every directory is a checkout of Branch, and git refuses
\* to check out a branch that another worktree has checked out.
CreateGitAdd(t) ==
  /\ createPc[t] = "add"
  /\ LET addOk == IF newBranch[t] THEN Branch \notin branches ELSE Branch \in branches /\ dirs = {}
     IN IF addOk
       THEN /\ dirs' = dirs \cup {t} /\ branches' = {Branch}
            /\ lock' = lock /\ SetPc(t, "insert")
       ELSE UNCHANGED <<dirs, branches>> /\ FailCreate(t)
  /\ UNCHANGED <<worktreeStatus, removals, deletions, awaited, newBranch, setupRunning, turnVars>>

\* Worktrees.ts:275-289 insert the row as preparing, fork setup, release the lock
CreateInsert(t) ==
  /\ createPc[t] = "insert"
  /\ worktreeStatus' = [worktreeStatus EXCEPT ![t] = "preparing"] /\ setupRunning' = setupRunning \cup {t}
  /\ lock' = "free" /\ SetPc(t, "thread")
  /\ UNCHANGED <<dirs, branches, removals, deletions, awaited, newBranch, turnVars>>

\* Threads.ts:100-113 the thread row is inserted after worktrees.create returns
ThreadInsert(t) ==
  /\ createPc[t] = "thread"
  /\ threadStatus' = [threadStatus EXCEPT ![t] = "idle"] /\ SetPc(t, "done")
  /\ UNCHANGED <<wtVars, awaited, newBranch, setupRunning, busyThreads, turnPc, cwd, sentWhileLive, settlePc>>

\* Worktrees.ts:216-231 setup ends ready or failed
SetupDone(r) ==
  /\ r \in setupRunning
  /\ \E s \in {"ready", "failed"} : worktreeStatus' = [worktreeStatus EXCEPT ![r] = s]
  /\ setupRunning' = setupRunning \ {r}
  /\ UNCHANGED <<dirs, branches, lock, removals, deletions, createPc, awaited, newBranch, turnVars>>

\* Worktrees.ts:291-306 ensureRemovable. Its "shared" check (300-305) is vacuous with one thread per row.
Removable(r) == worktreeStatus[r] /= "preparing" /\ threadStatus[r] /= "running"

FreeFiber == CHOOSE f \in Fibers : deletions[f].pc = "unused"

\* Worktrees.ts:329-339 remove: setStatus removed, forkDetach deleteFiles, removals.set
StartRemoval(r) ==
  /\ \E f \in Fibers : deletions[f].pc = "unused"
  /\ worktreeStatus' = [worktreeStatus EXCEPT ![r] = "removed"]
  /\ deletions' = [deletions EXCEPT ![FreeFiber] = [row |-> r, pc |-> "list", old |-> worktreeStatus[r]]]
  /\ removals' = FreeFiber

\* Worktrees.ts:329-339 remove when the row is already removed returns it unchanged
CanRemove(r) == lock = "free" /\ worktreeStatus[r] /= "none" /\ (worktreeStatus[r] = "removed" \/ Removable(r))
Remove(r) ==
  IF worktreeStatus[r] = "removed" THEN UNCHANGED <<worktreeStatus, deletions, removals>> ELSE StartRemoval(r)

\* ipc.ts:66 worktrees.remove with no owner, as DeleteProjectDialog.tsx:59 calls it
RemoveWorktree(r) ==
  /\ CanRemove(r) /\ worktreeStatus[r] /= "removed" /\ StartRemoval(r)
  /\ UNCHANGED <<dirs, branches, lock, createVars, turnVars>>

\* Threads.ts:139-146 settle removes the worktree with the thread as owner, then updates the thread
Settle(t) ==
  /\ threadStatus[t] \in {"idle", "running"} /\ settlePc[t] = "none" /\ CanRemove(t) /\ Remove(t)
  /\ settlePc' = [settlePc EXCEPT ![t] = "done"]
  /\ threadStatus' = [threadStatus EXCEPT ![t] = "settled"]
  /\ UNCHANGED <<dirs, branches, lock, createVars, busyThreads, turnPc, cwd, sentWhileLive>>

SetDel(f, pc) == deletions' = [deletions EXCEPT ![f].pc = pc]
DelUnchanged == UNCHANGED <<worktreeStatus, lock, removals, createVars, turnVars>>

\* Worktrees.ts:310 registeredCheckouts
DelList(f) ==
  /\ deletions[f].pc = "list"
  /\ SetDel(f, IF deletions[f].row \in dirs THEN "remove" ELSE "prune")
  /\ UNCHANGED <<dirs, branches>> /\ DelUnchanged

\* Worktrees.ts:311 git worktree remove --force, may fail
DelRemove(f) ==
  /\ deletions[f].pc = "remove"
  /\ \/ dirs' = dirs \ {deletions[f].row} /\ SetDel(f, "prune")
     \/ dirs' = dirs /\ SetDel(f, "restore")
  /\ UNCHANGED branches /\ DelUnchanged

\* Worktrees.ts:313 git worktree prune, may fail
DelPrune(f) ==
  /\ deletions[f].pc = "prune"
  /\ \E next \in {"branchCheck", "restore"} : SetDel(f, next)
  /\ UNCHANGED <<dirs, branches>> /\ DelUnchanged

\* Worktrees.ts:315-317 branchExists, then isMerged, whose answer is nondeterministic
DelBranchCheck(f) ==
  /\ deletions[f].pc = "branchCheck"
  /\ IF Branch \in branches THEN \E next \in {"branchD", "cleanup"} : SetDel(f, next) ELSE SetDel(f, "cleanup")
  /\ UNCHANGED <<dirs, branches>> /\ DelUnchanged

\* Worktrees.ts:318 git branch -D, may fail; git refuses a branch checked out in any worktree
DelBranchD(f) ==
  /\ deletions[f].pc = "branchD"
  /\ \/ Branch \in branches /\ dirs = {} /\ branches' = {} /\ SetDel(f, "cleanup")
     \/ branches' = branches /\ SetDel(f, "restore")
  /\ UNCHANGED dirs /\ DelUnchanged

\* Worktrees.ts:322-326 on any failure, setStatus back to the status remove read, then removals.delete
DelRestore(f) ==
  /\ deletions[f].pc = "restore"
  /\ worktreeStatus' = [worktreeStatus EXCEPT ![deletions[f].row] = deletions[f].old] /\ SetDel(f, "done")
  /\ removals' = 0
  /\ UNCHANGED <<dirs, branches, lock, createVars, turnVars>>

\* Worktrees.ts:326 removals.delete(key), whichever fiber the key now points to
DelCleanup(f) ==
  /\ deletions[f].pc = "cleanup"
  /\ removals' = 0 /\ SetDel(f, "done")
  /\ UNCHANGED <<worktreeStatus, dirs, branches, lock, createVars, turnVars>>

\* AgentRunner.ts:248-254 send claims busyThreads. startTurn then waits on exclusive(threadId) (246), which a
\* steer of the previous turn can hold across the provider.steer await.
Send(t) ==
  /\ threadStatus[t] /= "none" /\ t \notin busyThreads
  /\ busyThreads' = busyThreads \cup {t}
  /\ sentWhileLive' = [sentWhileLive EXCEPT ![t] = worktreeStatus[t] \in Live]
  /\ turnPc' = [turnPc EXCEPT ![t] = "start"]
  /\ UNCHANGED <<wtVars, createVars, threadStatus, cwd, settlePc>>

\* AgentRunner.ts:233-243 startTurn under the worktree lock: resolve cwd (workspace.ts:23-26 falls back to
\* the project root for a removed row) and mark the thread running.
StartTurn(t) ==
  /\ turnPc[t] = "start" /\ lock = "free"
  /\ cwd' = [cwd EXCEPT ![t] = IF worktreeStatus[t] = "removed" THEN Root ELSE t]
  /\ threadStatus' = [threadStatus EXCEPT ![t] = "running"] /\ turnPc' = [turnPc EXCEPT ![t] = "running"]
  /\ UNCHANGED <<wtVars, createVars, busyThreads, sentWhileLive, settlePc>>

\* AgentRunner.ts:44-56,164-168 handle(turn_completed | turn_failed) sets the thread idle
TurnCompleted(t) ==
  /\ turnPc[t] = "running"
  /\ threadStatus' = [threadStatus EXCEPT ![t] = "idle"] /\ turnPc' = [turnPc EXCEPT ![t] = "completed"]
  /\ UNCHANGED <<wtVars, createVars, busyThreads, cwd, sentWhileLive, settlePc>>

\* AgentRunner.ts:188-203 finish releases busyThreads, outside the worktree lock
Finish(t) ==
  /\ turnPc[t] = "completed"
  /\ busyThreads' = busyThreads \ {t} /\ turnPc' = [turnPc EXCEPT ![t] = "none"]
  /\ cwd' = [cwd EXCEPT ![t] = "none"]
  /\ UNCHANGED <<wtVars, createVars, threadStatus, sentWhileLive, settlePc>>

Next ==
  \/ \E t \in Threads :
       \/ CreateBegin(t) \/ CreateFindLive(t) \/ CreateBranchExists(t) \/ CreateGitAdd(t)
       \/ CreateInsert(t) \/ ThreadInsert(t) \/ SetupDone(t) \/ RemoveWorktree(t)
       \/ Settle(t) \/ Send(t) \/ StartTurn(t) \/ TurnCompleted(t) \/ Finish(t)
  \/ \E f \in Fibers :
       \/ DelList(f) \/ DelRemove(f) \/ DelPrune(f) \/ DelBranchCheck(f)
       \/ DelBranchD(f) \/ DelRestore(f) \/ DelCleanup(f)

Spec == Init /\ [][Next]_vars

-------------------------------------------------------------------------------------
NoDeleteUnderRunningTurn ==
  \A f \in Fibers, t \in Threads :
    ~(deletions[f].pc = "remove" /\ turnPc[t] = "running" /\ cwd[t] = deletions[f].row)

OneLiveWorktreePerBranch == Cardinality({r \in Rows : worktreeStatus[r] \in Live}) <= 1

DeletionInProgress == \E f \in Fibers : deletions[f].pc \in {"list", "remove", "prune", "branchCheck", "branchD", "restore"}
CreateWaitsForDeletion == \A t \in Threads : createPc[t] = "add" => ~DeletionInProgress

LiveRowHasDirectory == \A r \in Rows : worktreeStatus[r] \in {"ready", "failed"} => r \in dirs

TurnRunsWhereSent == \A t \in Threads : turnPc[t] = "running" /\ sentWhileLive[t] => cwd[t] = t
=====================================================================================
