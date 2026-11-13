------------------------------ MODULE WorktreeLifecycle ------------------------------
(* The worktree lifecycle in src/main/services/Worktrees.ts and its race with agent turns in
   src/main/services/AgentRunner.ts, for one project and one branch. *)
\* The model only includes threads that own a worktree, one each, so thread t's row and checkout are t.
\* A checkout directory and its `git worktree` registration are one thing: `remove --force` deletes both.
\* `awaiting_approval` is folded into `running`; both are busy per domain.ts isThreadBusy.
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
  lock,          \* Worktrees.ts lock, the Semaphore behind exclusive: the thread whose create holds it, or "free"
  removals,      \* Worktrees.ts removals, the one key's deletion fiber, 0 when absent
  deletions,     \* deletion fibers forked by remove
  createPc, awaited, newBranch, setupRunning,
  threadStatus, busyThreads, turnPc, cwd,
  sentToWorktree, \* AgentRunner.ts startClaimed, the thread worked in its live worktree when send claimed busyThreads
  archivePc

wtVars == <<worktreeStatus, dirs, branches, lock, removals, deletions>>
createVars == <<createPc, awaited, newBranch, setupRunning>>
turnVars == <<threadStatus, busyThreads, turnPc, cwd, sentToWorktree, archivePc>>
vars == <<wtVars, createVars, turnVars>>

DeletionPcs == {"unused", "list", "remove", "prune", "branchCheck", "branchD", "restore", "cleanup", "done"}

TypeOK ==
  /\ worktreeStatus \in [Rows -> Live \cup {"none", "removed"}]
  /\ dirs \subseteq Rows /\ branches \subseteq {Branch}
  /\ lock \in Threads \cup {"free"} /\ removals \in Fibers \cup {0}
  /\ deletions \in [Fibers -> [row : Rows \cup {"none"}, pc : DeletionPcs, old : Live \cup {"none"}]]
  /\ threadStatus \in [Threads -> {"none", "idle", "running", "archived"}]
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
  /\ sentToWorktree = [t \in Threads |-> FALSE]
  /\ archivePc = [t \in Threads |-> "none"]

SetPc(t, pc) == createPc' = [createPc EXCEPT ![t] = pc]
FailCreate(t) == lock' = "free" /\ SetPc(t, "idle")

\* Worktrees.ts create: acquire the lock, projects.get, removals.get
CreateBegin(t) ==
  /\ threadStatus[t] = "none" /\ createPc[t] = "idle" /\ lock = "free"
  /\ lock' = t /\ awaited' = [awaited EXCEPT ![t] = removals] /\ SetPc(t, "findLive")
  /\ UNCHANGED <<worktreeStatus, dirs, branches, removals, deletions, newBranch, setupRunning, turnVars>>

\* Worktrees.ts create: Fiber.await(removal), then findLive
CreateFindLive(t) ==
  /\ createPc[t] = "findLive"
  /\ IF awaited[t] = 0 THEN TRUE ELSE deletions[awaited[t]].pc = "done"
  /\ IF \E r \in Rows : worktreeStatus[r] \in Live THEN FailCreate(t) ELSE lock' = lock /\ SetPc(t, "branchExists")
  /\ UNCHANGED <<worktreeStatus, dirs, branches, removals, deletions, awaited, newBranch, setupRunning, turnVars>>

\* Worktrees.ts create: findCheckout, then worktreeAddArgs's branchExists. findCheckout returns free here: an
\* orphan only comes from a crash between `git worktree add` and the insert, and a branch taken by another
\* checkout is never Branch in the model, so neither is modeled.
CreateBranchExists(t) ==
  /\ createPc[t] = "branchExists"
  /\ newBranch' = [newBranch EXCEPT ![t] = Branch \notin branches] /\ SetPc(t, "add")
  /\ UNCHANGED <<wtVars, awaited, setupRunning, turnVars>>

\* Worktrees.ts create: git worktree add with worktreeAddArgs. Every directory is a checkout of Branch, and git refuses
\* to check out a branch that another worktree has checked out.
CreateGitAdd(t) ==
  /\ createPc[t] = "add"
  /\ LET addOk == IF newBranch[t] THEN Branch \notin branches ELSE Branch \in branches /\ dirs = {}
     IN IF addOk
       THEN /\ dirs' = dirs \cup {t} /\ branches' = {Branch}
            /\ lock' = lock /\ SetPc(t, "insert")
       ELSE UNCHANGED <<dirs, branches>> /\ FailCreate(t)
  /\ UNCHANGED <<worktreeStatus, removals, deletions, awaited, newBranch, setupRunning, turnVars>>

\* Worktrees.ts create: insert the row as preparing, fork setup, release the lock
CreateInsert(t) ==
  /\ createPc[t] = "insert"
  /\ worktreeStatus' = [worktreeStatus EXCEPT ![t] = "preparing"] /\ setupRunning' = setupRunning \cup {t}
  /\ lock' = "free" /\ SetPc(t, "thread")
  /\ UNCHANGED <<dirs, branches, removals, deletions, awaited, newBranch, turnVars>>

\* Threads.ts insertThread: the thread row is inserted after worktrees.create returns
ThreadInsert(t) ==
  /\ createPc[t] = "thread"
  /\ threadStatus' = [threadStatus EXCEPT ![t] = "idle"] /\ SetPc(t, "done")
  /\ UNCHANGED <<wtVars, awaited, newBranch, setupRunning, busyThreads, turnPc, cwd, sentToWorktree, archivePc>>

\* Worktrees.ts setup ends ready or failed
SetupDone(r) ==
  /\ r \in setupRunning
  /\ \E s \in {"ready", "failed"} : worktreeStatus' = [worktreeStatus EXCEPT ![r] = s]
  /\ setupRunning' = setupRunning \ {r}
  /\ UNCHANGED <<dirs, branches, lock, removals, deletions, createPc, awaited, newBranch, turnVars>>

\* Worktrees.ts stopSetup interrupts the setup fiber, whose onInterrupt marks the row failed. runSetupScript's
\* forceKillAfter escalates the kill to SIGKILL, so it returns even when the script ignores SIGTERM.
StopSetup(r) ==
  /\ r \in setupRunning
  /\ worktreeStatus' = [worktreeStatus EXCEPT ![r] = "failed"]
  /\ setupRunning' = setupRunning \ {r}
  /\ UNCHANGED <<dirs, branches, lock, removals, deletions, createPc, awaited, newBranch, turnVars>>

\* Worktrees.ts ensureRemovable. Its "shared" check is vacuous with one thread per row.
Removable(r) == threadStatus[r] /= "running"

FreeFiber == CHOOSE f \in Fibers : deletions[f].pc = "unused"

\* Worktrees.ts removeWhileExclusive: stopSetup, read the row again, setStatus removed, forkDetach
\* deleteFiles, removals.set. It holds the lock while stopSetup waits, and nothing that runs meanwhile reads
\* more than whether the row is live, which it stays, so the steps are one action. A failed deletion
\* restores the row as failed, never preparing, since no setup runs for it anymore.
StartRemoval(r) ==
  /\ \E f \in Fibers : deletions[f].pc = "unused"
  /\ worktreeStatus' = [worktreeStatus EXCEPT ![r] = "removed"]
  /\ setupRunning' = setupRunning \ {r}
  /\ deletions' = [deletions EXCEPT ![FreeFiber] =
       [row |-> r, pc |-> "list", old |-> IF r \in setupRunning THEN "failed" ELSE worktreeStatus[r]]]
  /\ removals' = FreeFiber

\* Worktrees.ts removeWhileExclusive: remove when the row is already removed returns it unchanged
CanRemove(r) == lock = "free" /\ worktreeStatus[r] /= "none" /\ (worktreeStatus[r] = "removed" \/ Removable(r))
Remove(r) ==
  IF worktreeStatus[r] = "removed" THEN UNCHANGED <<worktreeStatus, deletions, removals, setupRunning>>
  ELSE StartRemoval(r)

\* rpc.ts worktrees.remove with no owner, as DeleteProjectDialog.tsx DeleteProjectDialog calls it
RemoveWorktree(r) ==
  /\ CanRemove(r) /\ worktreeStatus[r] /= "removed" /\ StartRemoval(r)
  /\ UNCHANGED <<dirs, branches, lock, createPc, awaited, newBranch, turnVars>>

\* Threads.ts archiveIf, under the worktree lock, refuses a busy thread, and with Settings.archive.removeWorktree
\* on runs removeWorktreeIfSet with the thread as owner, then updates the thread. With the setting off it only
\* updates the thread, which races with nothing.
Archive(t) ==
  /\ threadStatus[t] = "idle" /\ archivePc[t] = "none" /\ CanRemove(t) /\ Remove(t)
  /\ archivePc' = [archivePc EXCEPT ![t] = "done"]
  /\ threadStatus' = [threadStatus EXCEPT ![t] = "archived"]
  /\ UNCHANGED <<dirs, branches, lock, createPc, awaited, newBranch, busyThreads, turnPc, cwd, sentToWorktree>>

SetDel(f, pc) == deletions' = [deletions EXCEPT ![f].pc = pc]
DelUnchanged == UNCHANGED <<worktreeStatus, lock, removals, createVars, turnVars>>

\* Worktrees.ts deleteFiles: registeredCheckouts
DelList(f) ==
  /\ deletions[f].pc = "list"
  /\ SetDel(f, IF deletions[f].row \in dirs THEN "remove" ELSE "prune")
  /\ UNCHANGED <<dirs, branches>> /\ DelUnchanged

\* Worktrees.ts deleteFiles: git worktree remove --force --force, may fail
DelRemove(f) ==
  /\ deletions[f].pc = "remove"
  /\ \/ dirs' = dirs \ {deletions[f].row} /\ SetDel(f, "prune")
     \/ dirs' = dirs /\ SetDel(f, "restore")
  /\ UNCHANGED branches /\ DelUnchanged

\* Worktrees.ts deleteFiles: git worktree prune, may fail
DelPrune(f) ==
  /\ deletions[f].pc = "prune"
  /\ \E next \in {"branchCheck", "restore"} : SetDel(f, next)
  /\ UNCHANGED <<dirs, branches>> /\ DelUnchanged

\* Worktrees.ts deleteFiles: branchExists, then whether to delete it (deleteBranch force, or
\* pruneMergedBranches finding it merged), which is nondeterministic
DelBranchCheck(f) ==
  /\ deletions[f].pc = "branchCheck"
  /\ IF Branch \in branches THEN \E next \in {"branchD", "cleanup"} : SetDel(f, next) ELSE SetDel(f, "cleanup")
  /\ UNCHANGED <<dirs, branches>> /\ DelUnchanged

\* Worktrees.ts deleteFiles: git branch -D, may fail; git refuses a branch checked out in any worktree
DelBranchD(f) ==
  /\ deletions[f].pc = "branchD"
  /\ \/ Branch \in branches /\ dirs = {} /\ branches' = {} /\ SetDel(f, "cleanup")
     \/ branches' = branches /\ SetDel(f, "restore")
  /\ UNCHANGED dirs /\ DelUnchanged

\* Worktrees.ts deleteFiles: on any failure, setStatus back to the status remove read if the checkout still exists,
\* then removals.delete. Only this fiber deletes the row's directory, so fs.exists and setStatus are one action.
DelRestore(f) ==
  /\ deletions[f].pc = "restore"
  /\ worktreeStatus' = IF deletions[f].row \in dirs
                         THEN [worktreeStatus EXCEPT ![deletions[f].row] = deletions[f].old]
                         ELSE worktreeStatus
  /\ SetDel(f, "done")
  /\ removals' = 0
  /\ UNCHANGED <<dirs, branches, lock, createVars, turnVars>>

\* Worktrees.ts deleteFiles: removals.delete(key), whichever fiber the key now points to
DelCleanup(f) ==
  /\ deletions[f].pc = "cleanup"
  /\ removals' = 0 /\ SetDel(f, "done")
  /\ UNCHANGED <<worktreeStatus, dirs, branches, lock, createVars, turnVars>>

\* AgentRunner.ts sendWhen claims busyThreads, and startClaimed reads the thread's live worktree
\* (workspace.ts makeActiveWorkspace). startTurn then waits on exclusive(threadId), which a steer of the
\* previous turn can hold across the provider.steer await.
Send(t) ==
  /\ threadStatus[t] /= "none" /\ t \notin busyThreads
  /\ busyThreads' = busyThreads \cup {t}
  /\ sentToWorktree' = [sentToWorktree EXCEPT ![t] = worktreeStatus[t] \in Live]
  /\ turnPc' = [turnPc EXCEPT ![t] = "start"]
  /\ UNCHANGED <<wtVars, createVars, threadStatus, cwd, archivePc>>

\* AgentRunner.ts startTurn under worktrees.exclusive: resolve cwd (workspace.ts makeActiveWorkspace falls back
\* to the project root for a removed row) and mark the thread running. An archived thread, or one sent to a
\* worktree that is no longer live, fails instead, and startClaimed releases busyThreads.
StartTurn(t) ==
  /\ turnPc[t] = "start" /\ lock = "free"
  /\ t \notin setupRunning  \* AgentRunner.ts startTurn waits for whenPrepared before taking the lock
  /\ IF threadStatus[t] = "archived" \/ (sentToWorktree[t] /\ worktreeStatus[t] = "removed")
       THEN /\ busyThreads' = busyThreads \ {t} /\ turnPc' = [turnPc EXCEPT ![t] = "none"]
            /\ UNCHANGED <<threadStatus, cwd>>
       ELSE /\ cwd' = [cwd EXCEPT ![t] = IF worktreeStatus[t] = "removed" THEN Root ELSE t]
            /\ threadStatus' = [threadStatus EXCEPT ![t] = "running"] /\ turnPc' = [turnPc EXCEPT ![t] = "running"]
            /\ UNCHANGED busyThreads
  /\ UNCHANGED <<wtVars, createVars, sentToWorktree, archivePc>>

\* AgentRunner.ts makeTurn handle(turn_completed | turn_failed) sets the thread idle via statusAfter
TurnCompleted(t) ==
  /\ turnPc[t] = "running"
  /\ threadStatus' = [threadStatus EXCEPT ![t] = "idle"] /\ turnPc' = [turnPc EXCEPT ![t] = "completed"]
  /\ UNCHANGED <<wtVars, createVars, busyThreads, cwd, sentToWorktree, archivePc>>

\* AgentRunner.ts makeTurn finish releases busyThreads, outside the worktree lock
Finish(t) ==
  /\ turnPc[t] = "completed"
  /\ busyThreads' = busyThreads \ {t} /\ turnPc' = [turnPc EXCEPT ![t] = "none"]
  /\ cwd' = [cwd EXCEPT ![t] = "none"]
  /\ UNCHANGED <<wtVars, createVars, threadStatus, sentToWorktree, archivePc>>

Next ==
  \/ \E t \in Threads :
       \/ CreateBegin(t) \/ CreateFindLive(t) \/ CreateBranchExists(t) \/ CreateGitAdd(t)
       \/ CreateInsert(t) \/ ThreadInsert(t) \/ SetupDone(t) \/ StopSetup(t) \/ RemoveWorktree(t)
       \/ Archive(t) \/ Send(t) \/ StartTurn(t) \/ TurnCompleted(t) \/ Finish(t)
  \/ \E f \in Fibers :
       \/ DelList(f) \/ DelRemove(f) \/ DelPrune(f) \/ DelBranchCheck(f)
       \/ DelBranchD(f) \/ DelRestore(f) \/ DelCleanup(f)

Spec == Init /\ [][Next]_vars

\* The user keeps asking to archive (strong fairness: retrying whenever archiving is possible), and every
\* turn ends, by itself or by Stop. SetupDone gets no fairness, so archiving does not rely on Worktrees.ts
\* SETUP_TIMEOUT ending a setup script that hangs.
LiveSpec == Spec /\ \A t \in Threads : SF_vars(Archive(t)) /\ WF_vars(TurnCompleted(t))

-------------------------------------------------------------------------------------
NoDeleteUnderRunningTurn ==
  \A f \in Fibers, t \in Threads :
    ~(deletions[f].pc = "remove" /\ turnPc[t] = "running" /\ cwd[t] = deletions[f].row)

OneLiveWorktreePerBranch == Cardinality({r \in Rows : worktreeStatus[r] \in Live}) <= 1

DeletionInProgress == \E f \in Fibers : deletions[f].pc \in {"list", "remove", "prune", "branchCheck", "branchD", "restore"}
CreateWaitsForDeletion == \A t \in Threads : createPc[t] = "add" => ~DeletionInProgress

LiveRowHasDirectory == \A r \in Rows : worktreeStatus[r] \in {"ready", "failed"} => r \in dirs

TurnRunsWhereSent == \A t \in Threads : turnPc[t] = "running" /\ sentToWorktree[t] => cwd[t] = t

\* No thread gets stuck: whatever its worktree's setup script does, archiving it eventually works. Retried
\* failed deletions can use up MaxRemovals, after which the bound, not the code, refuses a removal.
FibersExhausted == \A f \in Fibers : deletions[f].pc /= "unused"
ArchiveEventually == \A t \in Threads : threadStatus[t] /= "none" ~> threadStatus[t] = "archived" \/ FibersExhausted
=====================================================================================
