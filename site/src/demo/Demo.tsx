import { startTransition, useEffect, useReducer, useRef, useState, type ActionDispatch } from "react"
import { RiGitMergeLine, RiGitPullRequestLine } from "react-icons/ri"
import { BranchIcon, RefreshIcon, SidebarIcon } from "../icons.ts"
import type { DemoCopy } from "./copy.ts"
import { Details } from "./Details.tsx"
import { createState, isWorking, nextDelay, reducer, statusOf, type Action, type Thread } from "./engine.ts"
import { seeds } from "./script.ts"
import { Composer, Transcript } from "./Transcript.tsx"
import { ProviderMark, providerName, segmentsOf, STREAM_STEP_MS, StatusGlyph } from "./ui.tsx"

const FIRST_THREAD = "flaky-login"

type Props = { copy: DemoCopy; locale: string }

export default function Demo({ copy, locale }: Props) {
  const [state, dispatch] = useReducer(reducer, copy, (initial) => createState(seeds(initial), FIRST_THREAD))
  const [started, setStarted] = useState(false)
  const [view, setView] = useState<"inbox" | "threads">("inbox")
  const [detailsOpen, setDetailsOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = root.current
    if (!node) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        setStarted(true)
        observer.disconnect()
      },
      { threshold: 0.35 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const active = state.threads.find((thread) => thread.id === state.activeId) ?? state.threads[0]!
  const select = (threadId: string) => startTransition(() => dispatch({ type: "select", threadId }))
  const restart = () =>
    startTransition(() => {
      dispatch({ type: "reset", state: createState(seeds(copy), FIRST_THREAD) })
      setView("inbox")
      setDetailsOpen(false)
    })

  return (
    <div ref={root} className="@container">
      {started &&
        state.threads.map((thread) => (
          <Ticker key={`${thread.id}-${thread.tick}`} thread={thread} locale={locale} dispatch={dispatch} />
        ))}
      <section
        aria-label={copy.site_demo_label}
        className="overflow-hidden rounded-2xl bg-paper text-ink shadow-window"
      >
        <div className="flex h-10 items-center gap-3 border-b border-line bg-surface px-3.5">
          <span aria-hidden className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
          </span>
          <span className="text-xs font-semibold tracking-tight">HinaCode</span>
          <button
            type="button"
            onClick={restart}
            className="pressable ms-auto inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-ink-soft hover:bg-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-teal"
          >
            <RefreshIcon aria-hidden className="size-3.5" />
            {copy.site_demo_restart}
          </button>
        </div>

        <div className="flex h-[36rem] @3xl:h-[38rem]">
          <Sidebar {...{ state: state.threads, activeId: state.activeId, view, setView, select, copy }} />

          <div className="flex min-w-0 flex-1 flex-col">
            <ThreadHeader thread={active} copy={copy} detailsOpen={detailsOpen} setDetailsOpen={setDetailsOpen} />
            <ThreadStrip threads={state.threads} activeId={state.activeId} select={select} copy={copy} />
            <div className={`min-h-0 flex-1 flex-col ${detailsOpen ? "hidden @5xl:flex" : "flex"}`}>
              <Transcript
                key={`transcript-${active.id}`}
                thread={active}
                copy={copy}
                locale={locale}
                dispatch={dispatch}
              />
              <Composer key={`composer-${active.id}`} thread={active} copy={copy} dispatch={dispatch} />
            </div>
            <div className={`min-h-0 flex-1 overflow-y-auto ${detailsOpen ? "block @5xl:hidden" : "hidden"}`}>
              <Details thread={active} copy={copy} dispatch={dispatch} />
            </div>
          </div>

          <aside
            aria-label={copy.panel_tab_details}
            className="hidden w-[17rem] shrink-0 overflow-y-auto border-s border-line bg-surface/60 @5xl:block"
          >
            <Details thread={active} copy={copy} dispatch={dispatch} />
          </aside>
        </div>
      </section>
    </div>
  )
}

function Ticker({ thread, locale, dispatch }: { thread: Thread; locale: string; dispatch: ActionDispatch<[Action]> }) {
  const working = isWorking(thread)
  const last = thread.items.at(-1)
  const streaming =
    last?.kind === "assistant" && last.animate ? segmentsOf(last.text, locale).length * STREAM_STEP_MS : 0
  const delay = nextDelay(thread) + streaming
  const { id } = thread

  useEffect(() => {
    if (!working) return
    const timer = setTimeout(() => dispatch({ type: "advance", threadId: id }), delay)
    return () => clearTimeout(timer)
  }, [working, delay, id, dispatch])

  return null
}

type SidebarProps = {
  state: Thread[]
  activeId: string
  view: "inbox" | "threads"
  setView: (view: "inbox" | "threads") => void
  select: (threadId: string) => void
  copy: DemoCopy
}

function Sidebar({ state: threads, activeId, view, setView, select, copy }: SidebarProps) {
  const waiting = threads.filter((thread) => statusOf(thread) === "needs-you").length
  const projects = [...new Set(threads.map((thread) => thread.project))]
  const tab = (value: "inbox" | "threads", label: string, count = 0) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => startTransition(() => setView(value))}
      className="pressable inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-ink-soft hover:text-ink aria-pressed:bg-paper aria-pressed:text-ink aria-pressed:shadow-[0_0_0_1px_var(--color-line)] focus-visible:outline-2 focus-visible:outline-teal"
    >
      {label}
      {count > 0 && (
        <span className="grid h-4 min-w-4 place-items-center rounded-full bg-attention px-1 text-[10px] font-semibold text-paper tabular-nums">
          {count}
        </span>
      )}
    </button>
  )

  return (
    <nav
      aria-label={copy.sidebar_tab_threads}
      className="hidden w-[15.5rem] shrink-0 flex-col border-e border-line bg-surface/60 @3xl:flex"
    >
      <div className="flex gap-1 px-2.5 pt-2.5 pb-2">
        {tab("inbox", copy.sidebar_tab_inbox, waiting)}
        {tab("threads", copy.sidebar_tab_threads)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {view === "inbox" ? (
          <ThreadList threads={threads} activeId={activeId} select={select} copy={copy} />
        ) : (
          projects.map((project) => (
            <div key={project} className="mt-2 first:mt-0">
              <p className="px-2.5 pt-1 pb-1 text-xs font-medium text-ink-soft">{project}</p>
              <ThreadList
                threads={threads.filter((thread) => thread.project === project)}
                activeId={activeId}
                select={select}
                copy={copy}
              />
            </div>
          ))
        )}
      </div>
    </nav>
  )
}

function ThreadList({
  threads,
  activeId,
  select,
  copy,
}: {
  threads: Thread[]
  activeId: string
  select: (threadId: string) => void
  copy: DemoCopy
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {threads.map((thread) => {
        const status = statusOf(thread)
        return (
          <li key={thread.id}>
            <button
              type="button"
              aria-current={thread.id === activeId ? "true" : undefined}
              onClick={() => select(thread.id)}
              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-start transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal aria-[current=true]:bg-muted"
            >
              <span className="mt-[3px]">
                <StatusGlyph status={status} unseen={thread.unseen} copy={copy} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[13px] text-ink ${thread.unseen ? "font-semibold" : "font-medium"}`}
                >
                  {thread.title}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-ink-soft">
                  <ProviderMark provider={thread.provider} className="size-3" />
                  {status === "needs-you" ? (
                    <span className="truncate text-[11px] font-semibold text-attention">
                      {copy.site_demo_needs_you}
                    </span>
                  ) : (
                    <span className="truncate font-mono text-[11px]">{thread.branch}</span>
                  )}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ThreadStrip({
  threads,
  activeId,
  select,
  copy,
}: {
  threads: Thread[]
  activeId: string
  select: (threadId: string) => void
  copy: DemoCopy
}) {
  return (
    <ul className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2 @3xl:hidden">
      {threads.map((thread) => (
        <li key={thread.id} className="shrink-0">
          <button
            type="button"
            aria-current={thread.id === activeId ? "true" : undefined}
            onClick={() => select(thread.id)}
            className="pressable flex h-8 max-w-[12rem] items-center gap-1.5 rounded-full px-3 text-xs font-medium text-ink-soft shadow-[0_0_0_1px_var(--color-line)] aria-[current=true]:bg-muted aria-[current=true]:text-ink focus-visible:outline-2 focus-visible:outline-teal"
          >
            <StatusGlyph status={statusOf(thread)} unseen={thread.unseen} copy={copy} />
            <span className="truncate">{thread.title}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ThreadHeader({
  thread,
  copy,
  detailsOpen,
  setDetailsOpen,
}: {
  thread: Thread
  copy: DemoCopy
  detailsOpen: boolean
  setDetailsOpen: (open: boolean) => void
}) {
  const { pr } = thread
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
      <h3 className="min-w-0 truncate text-[13px] font-semibold">{thread.title}</h3>
      <span className="hidden shrink-0 items-center gap-1 text-xs text-ink-soft @lg:flex">
        <ProviderMark provider={thread.provider} className="size-3.5" />
        {providerName(copy, thread.provider)}
      </span>
      <span className="hidden min-w-0 items-center gap-1 text-ink-soft @2xl:flex">
        <BranchIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate font-mono text-[11px]">{thread.branch}</span>
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-1.5">
        {pr && (
          <span className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 font-mono text-[11px] text-ink">
            {pr.state === "merged" ? (
              <RiGitMergeLine aria-hidden className="size-3.5 text-merged" />
            ) : (
              <RiGitPullRequestLine aria-hidden className="size-3.5 text-teal" />
            )}
            #{pr.number}
          </span>
        )}
        <button
          type="button"
          aria-pressed={detailsOpen}
          aria-label={copy.panel_tab_details}
          onClick={() => startTransition(() => setDetailsOpen(!detailsOpen))}
          className="pressable grid size-7 place-items-center rounded-lg text-ink-soft hover:bg-muted hover:text-ink aria-pressed:bg-muted aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-teal @5xl:hidden"
        >
          <SidebarIcon aria-hidden className="size-4 -scale-x-100" />
        </button>
      </span>
    </div>
  )
}
