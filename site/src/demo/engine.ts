export type ProviderId = "claude" | "codex" | "muse"
export type ToolKind = "read" | "search" | "edit" | "run" | "mcp"
export type CheckStatus = "pending" | "passing" | "failing"
export type Decision = "allow" | "session" | "deny"
export type ThreadStatus = "needs-you" | "running" | "failing" | "done"

export type Flags = { decision?: Decision; note?: string; answer?: string }
type Text = string | ((flags: Flags) => string)

export type QuestionOption = { label: string; hint: string }
export type DiffLine = { sign: "+" | "-"; code: string }

export type Item =
  | { kind: "user"; id: number; text: string; steered: boolean }
  | { kind: "assistant"; id: number; text: string; animate: boolean }
  | {
      kind: "tool"
      id: number
      tool: ToolKind
      target: string
      added?: number
      removed?: number
      diff?: DiffLine[]
      output?: string
      running: boolean
    }
  | { kind: "approval"; id: number; command: string; reason: string; decision?: Decision; note?: string }
  | { kind: "question"; id: number; question: string; options: QuestionOption[]; answer?: string }
  | { kind: "event"; id: number; text: string; tone: "attention" | "success" }
  | { kind: "worked"; id: number; duration: string }

type ToolStep = {
  do: "tool"
  tool: ToolKind
  target: string
  added?: number
  removed?: number
  diff?: DiffLine[]
  output?: string
  ms: number
}

type StepBody =
  | { do: "user"; text: string }
  | { do: "say"; text: Text }
  | ToolStep
  | { do: "approval"; command: string; reason: string }
  | { do: "question"; question: string; options: QuestionOption[] }
  | { do: "pr"; number: number; title: string; checks: Record<string, CheckStatus>; watching?: boolean }
  | { do: "checks"; checks: Record<string, CheckStatus> }
  | { do: "event"; text: Text; tone: "attention" | "success" }
  | { do: "worked"; duration: string }
  | { do: "rest" }

export type Step = StepBody & { wait?: number; when?: (flags: Flags) => boolean }

export type PullRequest = {
  number: number
  title: string
  checks: Record<string, CheckStatus>
  state: "open" | "merging" | "merged"
  watching: boolean
}

export type Thread = {
  id: string
  title: string
  project: string
  branch: string
  provider: ProviderId
  ports: string[]
  replyTo: { followup: string; steer: string }
  steps: Step[]
  cursor: number
  items: Item[]
  flags: Flags
  replies: string[]
  queue: string[]
  pr: PullRequest | null
  resting: boolean
  unseen: boolean
  worktreeRemoved: boolean
  tick: number
}

export type DemoState = { threads: Thread[]; activeId: string; nextId: number }

export type Action =
  | { type: "advance"; threadId: string }
  | { type: "select"; threadId: string }
  | { type: "decide"; threadId: string; itemId: number; decision: Decision; note: string }
  | { type: "answer"; threadId: string; itemId: number; answer: string }
  | { type: "send"; threadId: string; text: string; mode: "send" | "queue" | "steer" }
  | { type: "merge"; threadId: string }
  | { type: "merged"; threadId: string; event: string }
  | { type: "reset"; state: DemoState }

export type ThreadSeed = Omit<
  Thread,
  "cursor" | "items" | "flags" | "replies" | "queue" | "pr" | "resting" | "unseen" | "worktreeRemoved" | "tick"
> & { prefill: Step[] }

export function createState(seeds: ThreadSeed[], activeId: string): DemoState {
  let state: DemoState = { threads: [], activeId, nextId: 1 }
  for (const { prefill, ...seed } of seeds) {
    const blank: Thread = {
      ...seed,
      steps: [...prefill, ...seed.steps],
      cursor: 0,
      items: [],
      flags: {},
      replies: [],
      queue: [],
      pr: null,
      resting: false,
      unseen: false,
      worktreeRemoved: false,
      tick: 0,
    }
    state = { ...state, threads: [...state.threads, blank] }
    const current = () => state.threads.find((thread) => thread.id === seed.id)!
    while (current().cursor < prefill.length || runningTool(current())) state = applyNext(state, seed.id, false)
  }
  return state
}

export function isBlocked(thread: Thread) {
  return thread.items.some(
    (item) => (item.kind === "approval" && !item.decision) || (item.kind === "question" && !item.answer),
  )
}

function runningTool(thread: Thread) {
  const tool = thread.items.findLast((item) => item.kind === "tool" && item.running)
  return tool?.kind === "tool" ? tool : null
}

function nextStepIndex(thread: Thread) {
  let index = thread.cursor
  while (index < thread.steps.length && !(thread.steps[index]!.when?.(thread.flags) ?? true)) index++
  return index
}

export function isWorking(thread: Thread) {
  if (isBlocked(thread)) return false
  return (
    runningTool(thread) !== null ||
    thread.replies.length > 0 ||
    thread.queue.length > 0 ||
    nextStepIndex(thread) < thread.steps.length
  )
}

export function statusOf(thread: Thread): ThreadStatus {
  if (isBlocked(thread)) return "needs-you"
  if (isWorking(thread) && !thread.resting) return "running"
  if (thread.pr && thread.pr.state === "open" && Object.values(thread.pr.checks).includes("failing")) return "failing"
  return "done"
}

export function nextDelay(thread: Thread) {
  const tool = runningTool(thread)
  if (tool)
    return thread.steps[thread.cursor - 1]?.do === "tool" ? (thread.steps[thread.cursor - 1] as ToolStep).ms : 600
  if (thread.replies.length > 0) return 900
  const step = thread.steps[nextStepIndex(thread)]
  if (!step) return 700
  if (step.wait !== undefined) return step.wait
  if (step.do === "say") return 500
  if (step.do === "tool") return 450
  return 600
}

function updateThread(state: DemoState, threadId: string, update: (thread: Thread) => Thread): DemoState {
  return { ...state, threads: state.threads.map((thread) => (thread.id === threadId ? update(thread) : thread)) }
}

function addItem(state: DemoState, threadId: string, item: DistributiveOmit<Item, "id">): DemoState {
  const id = state.nextId
  return {
    ...updateThread(state, threadId, (thread) => ({
      ...thread,
      items: [...thread.items, { ...item, id } as Item],
      unseen: thread.unseen || state.activeId !== threadId,
      tick: thread.tick + 1,
    })),
    nextId: id + 1,
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

function say(state: DemoState, threadId: string, text: string, animate: boolean) {
  return addItem(state, threadId, { kind: "assistant", text, animate: animate && state.activeId === threadId })
}

function applyNext(state: DemoState, threadId: string, animate = true): DemoState {
  const thread = state.threads.find((candidate) => candidate.id === threadId)
  if (!thread || isBlocked(thread)) return state

  const tool = runningTool(thread)
  if (tool) {
    return updateThread(state, threadId, (current) => ({
      ...current,
      items: current.items.map((item) => (item.id === tool.id ? { ...tool, running: false } : item)),
      tick: current.tick + 1,
    }))
  }

  const [reply, ...replies] = thread.replies
  if (reply !== undefined) {
    const next = updateThread(state, threadId, (current) => ({ ...current, replies, resting: false }))
    return say(next, threadId, reply, animate)
  }

  const index = nextStepIndex(thread)
  const step = thread.steps[index]
  if (!step) {
    const [queued, ...queue] = thread.queue
    if (queued === undefined) return state
    const next = updateThread(state, threadId, (current) => ({
      ...current,
      queue,
      replies: [...current.replies, current.replyTo.followup],
    }))
    return addItem(next, threadId, { kind: "user", text: queued, steered: false })
  }

  const advanced = updateThread(state, threadId, (current) => ({
    ...current,
    cursor: index + 1,
    resting: step.do === "rest" || (current.resting && (step.do === "checks" || step.do === "worked")),
    tick: current.tick + 1,
  }))
  const flags = thread.flags
  const text = (value: Text) => (typeof value === "function" ? value(flags) : value)

  switch (step.do) {
    case "user":
      return addItem(advanced, threadId, { kind: "user", text: step.text, steered: false })
    case "say":
      return say(advanced, threadId, text(step.text), animate)
    case "tool": {
      const { do: _kind, ms: _ms, wait: _wait, when: _when, ...rest } = step
      return addItem(advanced, threadId, { kind: "tool", ...rest, running: true })
    }
    case "approval":
      return addItem(advanced, threadId, { kind: "approval", command: step.command, reason: step.reason })
    case "question":
      return addItem(advanced, threadId, { kind: "question", question: step.question, options: step.options })
    case "event":
      return addItem(advanced, threadId, { kind: "event", text: text(step.text), tone: step.tone })
    case "worked":
      return addItem(advanced, threadId, { kind: "worked", duration: step.duration })
    case "pr":
      return updateThread(advanced, threadId, (current) => ({
        ...current,
        pr: { number: step.number, title: step.title, checks: step.checks, state: "open", watching: !!step.watching },
      }))
    case "checks":
      return updateThread(advanced, threadId, (current) =>
        current.pr ? { ...current, pr: { ...current.pr, checks: { ...current.pr.checks, ...step.checks } } } : current,
      )
    case "rest":
      return advanced
  }
}

export function reducer(state: DemoState, action: Action): DemoState {
  switch (action.type) {
    case "advance":
      return applyNext(state, action.threadId)
    case "select":
      return {
        ...state,
        activeId: action.threadId,
        threads: state.threads.map((thread) => ({
          ...thread,
          unseen: thread.id === action.threadId ? false : thread.unseen,
          items:
            thread.id === state.activeId
              ? thread.items.map((item) =>
                  item.kind === "assistant" && item.animate ? { ...item, animate: false } : item,
                )
              : thread.items,
        })),
      }
    case "decide":
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        flags: { ...thread.flags, decision: action.decision, note: action.note },
        items: thread.items.map((item) =>
          item.id === action.itemId && item.kind === "approval"
            ? { ...item, decision: action.decision, note: action.note.trim() || undefined }
            : item,
        ),
        tick: thread.tick + 1,
      }))
    case "answer":
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        flags: { ...thread.flags, answer: action.answer },
        items: thread.items.map((item) =>
          item.id === action.itemId && item.kind === "question" ? { ...item, answer: action.answer } : item,
        ),
        tick: thread.tick + 1,
      }))
    case "send": {
      if (action.mode === "queue") {
        return updateThread(state, action.threadId, (thread) => ({
          ...thread,
          queue: [...thread.queue, action.text],
          tick: thread.tick + 1,
        }))
      }
      const next = updateThread(state, action.threadId, (thread) => ({
        ...thread,
        replies: [...thread.replies, action.mode === "steer" ? thread.replyTo.steer : thread.replyTo.followup],
        resting: false,
      }))
      return addItem(next, action.threadId, { kind: "user", text: action.text, steered: action.mode === "steer" })
    }
    case "merge":
      return updateThread(state, action.threadId, (thread) =>
        thread.pr ? { ...thread, pr: { ...thread.pr, state: "merging" } } : thread,
      )
    case "merged": {
      const next = updateThread(state, action.threadId, (thread) =>
        thread.pr ? { ...thread, pr: { ...thread.pr, state: "merged" }, worktreeRemoved: true } : thread,
      )
      return addItem(next, action.threadId, { kind: "event", text: action.event, tone: "success" })
    }
    case "reset":
      return action.state
  }
}
