import type { AgentEvent, Subagent } from "../../../../shared/agent.ts"

interface Step {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly output: string
}

interface Script {
  readonly id: string
  readonly label: string
  readonly prompt: string
  readonly status: Subagent["status"]
  readonly startedSecondsAgo: number
  readonly ranSeconds?: number
  readonly steps: ReadonlyArray<Step>
  readonly upcoming?: ReadonlyArray<Step>
  readonly report?: string
}

const read = (file: string, output: string): Step => ({ name: "Read", input: { file_path: file }, output })
const grep = (pattern: string, output: string): Step => ({ name: "Grep", input: { pattern }, output })
const bash = (command: string, output: string): Step => ({ name: "Bash", input: { command }, output })

const scripts: ReadonlyArray<Script> = [
  {
    id: "mock-agent-composer",
    label: "Audit the composer",
    prompt: "Find every place the composer sets state outside a transition and list the fixes.",
    status: "running",
    startedSecondsAgo: 42,
    steps: [
      read("src/renderer/components/Composer.tsx", "export function Composer({ thread, children }) {"),
      grep("setError\\(", "src/renderer/components/Composer.tsx:190: setError(errorMessage(cause))"),
    ],
    upcoming: [
      read("src/renderer/components/ComposerControls.tsx", "export function ComposerControls() {"),
      grep("startTransition", "src/renderer/components/Composer.tsx:12: import { startTransition }"),
      bash("pnpm lint src/renderer/components", "2 warnings"),
      read("src/renderer/components/ComposerInput.tsx", "export function ComposerInput() {"),
    ],
    report:
      "Two handlers set state outside a transition: `onStop` in Composer.tsx:190 and `setIndex` in ComposerControls.tsx:514. Both can move into the Button `action` prop.",
  },
  {
    id: "mock-agent-flaky",
    label: "Reproduce the flaky macOS job",
    prompt: "Run the e2e suite for threads.feature five times and report which scenario fails.",
    status: "running",
    startedSecondsAgo: 128,
    steps: [
      bash("pnpm test:e2e --grep threads", "12 passed (41s)"),
      bash("pnpm test:e2e --grep threads", "11 passed, 1 failed (44s)"),
    ],
    upcoming: [
      read("e2e/steps/threads.steps.ts", 'When("I open the sidebar tab {string}"'),
      bash("pnpm test:e2e --grep threads", "12 passed (40s)"),
      grep("toBeInViewport", "e2e/steps/threads.steps.ts:75"),
      bash("pnpm test:e2e --grep threads", "11 passed, 1 failed (46s)"),
    ],
  },
  {
    id: "mock-agent-migrations",
    label: "Review the project actions migration",
    prompt: "Check that migration 0032 is additive and that old rows decode.",
    status: "completed",
    startedSecondsAgo: 300,
    ranSeconds: 74,
    steps: [
      read("src/main/db/migrations/0032_project_actions.ts", "ALTER TABLE project ADD COLUMN actions"),
      read("src/main/services/Projects.ts", "actions: Schema.fromJsonString(Schema.Array(ProjectAction))"),
      bash("pnpm test src/main/services/Projects.integration.test.ts", "8 passed"),
    ],
    report:
      "The migration only adds a column with a `'[]'` default, so existing rows decode to an empty list. No change needed.",
  },
  {
    id: "mock-agent-icons",
    label: "Find Lucide imports",
    prompt: "List every file that still imports from lucide-react.",
    status: "completed",
    startedSecondsAgo: 520,
    ranSeconds: 18,
    steps: [grep('from "lucide-react"', "No matches found")],
    report: "No file imports lucide-react.",
  },
  {
    id: "mock-agent-bench",
    label: "Benchmark the sidebar render",
    prompt: "Measure the sidebar's render time with 500 threads.",
    status: "failed",
    startedSecondsAgo: 760,
    ranSeconds: 31,
    steps: [bash("node scripts/perf/measure.ts sidebar", "Error: CDP port 9229 is already in use")],
    report: "Could not attach to the app: port 9229 is already in use.",
  },
  {
    id: "mock-agent-docs",
    label: "Rewrite the arch diagram",
    prompt: "Update docs/arch.md for the overview panel.",
    status: "stopped",
    startedSecondsAgo: 940,
    ranSeconds: 12,
    steps: [read("docs/arch.md", "```mermaid")],
  },
]

const secondsAgo = (now: number, seconds: number) => new Date(now - seconds * 1000).toISOString()

const callIdOf = (script: Pick<Script, "id">) => `${script.id}-call`

const stepEvents = (script: Script, step: Step, index: number): Array<AgentEvent> => {
  const callId = `${script.id}-step-${index}`
  return [
    { type: "tool_call_started", callId, name: step.name, input: step.input, parentCallId: callIdOf(script) },
    { type: "tool_call_finished", callId, output: step.output, isError: false },
  ]
}

export function mockSubagents(now: number) {
  const agents = new Map<string, Subagent>()
  const progress = new Map<string, number>()

  const update = (subagent: Subagent): AgentEvent => {
    agents.set(subagent.id, subagent)
    return { type: "subagent_updated", subagent }
  }

  const finish = (
    script: Script,
    status: Exclude<Subagent["status"], "running">,
    at: number,
    report: string | undefined = script.report,
  ) => {
    const current = agents.get(script.id)
    if (current === undefined) return []
    return [
      {
        type: "tool_call_finished",
        callId: callIdOf(script),
        output: report ?? "Stopped before it finished.",
        isError: status === "failed",
      } satisfies AgentEvent,
      update({ ...current, status, summary: report ?? null, endedAt: new Date(at).toISOString() }),
    ]
  }

  const initial: Array<AgentEvent> = scripts.toReversed().flatMap((script) => {
    const startedAt = secondsAgo(now, script.startedSecondsAgo)
    progress.set(script.id, 0)
    const events: Array<AgentEvent> = [
      {
        type: "tool_call_started",
        callId: callIdOf(script),
        name: "Agent",
        input: { description: script.label, prompt: script.prompt, subagent_type: "general-purpose" },
      },
      ...script.steps.flatMap((step, index) => stepEvents(script, step, index)),
      update({
        id: script.id,
        label: script.label,
        callId: callIdOf(script),
        status: "running",
        summary: null,
        lastTool: script.steps.at(-1)?.name ?? null,
        toolUses: script.steps.length,
        tokens: 2400 * script.steps.length + 800,
        startedAt,
        endedAt: null,
      }),
    ]
    if (script.status === "running") return events
    return [...events, ...finish(script, script.status, Date.parse(startedAt) + (script.ranSeconds ?? 0) * 1000)]
  })

  const tick = (at: number): Array<AgentEvent> =>
    scripts.flatMap((script) => {
      const current = agents.get(script.id)
      if (current?.status !== "running") return []
      const done = progress.get(script.id) ?? 0
      const step = script.upcoming?.[done]
      if (step === undefined) return script.report ? finish(script, "completed", at) : []
      progress.set(script.id, done + 1)
      return [
        ...stepEvents(script, step, script.steps.length + done),
        update({
          ...current,
          lastTool: step.name,
          toolUses: (current.toolUses ?? 0) + 1,
          tokens: (current.tokens ?? 0) + 2400,
        }),
      ]
    })

  const stop = (subagentId: string, at: number) => {
    const script = scripts.find((candidate) => candidate.id === subagentId)
    return script && agents.get(subagentId)?.status === "running" ? finish(script, "stopped", at, undefined) : []
  }

  return { initial, tick, stop }
}
