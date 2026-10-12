import type { LegendListRef } from "@legendapp/list/react"
import { type KeyboardEvent, type RefObject, useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import { RiArrowDownSLine, RiArrowUpSLine, RiCloseLine, RiSearchLine } from "react-icons/ri"
import type { Message } from "../../shared/domain.ts"
import { type FindMatch, findMatches } from "../lib/find.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { partMatchSelector } from "./FindHighlight.tsx"
import { Button } from "./ui/button.tsx"

/** Frames to wait for a row to mount after the list scrolls to it. */
const MOUNT_WAIT_FRAMES = 10

/** Survives remounts, so a find bar that reappears with its thread does not take focus again. */
let handledFocusRequest = 0

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/**
 * Scrolls the virtual list to the match's message, then the `ordinal`-th mark of the match's part to
 * the middle of the view. Resolves to the mark, or null when it never mounted.
 */
async function scrollToMatch(list: LegendListRef, index: number, match: FindMatch, ordinal: number) {
  await list.scrollToIndex({ index, viewPosition: 0.5, animated: false })
  for (let frame = 0; frame < MOUNT_WAIT_FRAMES; frame++) {
    const row = list.getScrollableNode()?.querySelector(`[data-message-id="${CSS.escape(match.messageId)}"]`)
    // A match behind a disclosure has no mark until the disclosure opens, a render or two later.
    const mark = row?.querySelectorAll<HTMLElement>(partMatchSelector(match.partIndex))[ordinal]
    if (mark) {
      mark.scrollIntoView({ block: "center", behavior: "instant" })
      return mark
    }
    await nextFrame()
  }
  return null
}

/** Position of `matches[current]` among the matches in its own part. */
const ordinalInPart = (matches: ReadonlyArray<FindMatch>, current: number) => {
  const target = matches[current]
  return matches
    .slice(0, current)
    .filter((match) => match.messageId === target?.messageId && match.partIndex === target.partIndex).length
}

/**
 * Find in the open thread. Matches come from the transcript in the store, not the DOM, because the
 * list only mounts the rows on screen.
 */
export function FindBar({
  messages,
  query,
  listRef,
}: {
  messages: ReadonlyArray<Message>
  /** The debounced query the transcript is highlighting. */
  query: string
  listRef: RefObject<LegendListRef | null>
}) {
  const typed = useUi((state) => state.findQuery)
  const setQuery = useUi((state) => state.setFindQuery)
  const closeFind = useUi((state) => state.closeFind)
  const setTarget = useUi((state) => state.setFindTarget)
  const focusRequest = useUi((state) => state.findFocusRequest)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<Element | null>(null)
  const currentMark = useRef<HTMLElement | null>(null)
  const revealToken = useRef(0)

  const startMessageId = useUi((state) => state.findMessageId)
  const matches = useMemo(() => findMatches(messages, query), [messages, query])
  // New text starts at the last match, nearest the end of the transcript where the reader usually is,
  // or at the message a global search result pointed to.
  const start = useMemo(() => {
    const inMessage = matches.findLastIndex((match) => match.messageId === startMessageId)
    return inMessage === -1 ? matches.length - 1 : inMessage
  }, [matches, startMessageId])
  const [selected, setSelected] = useState<{ query: string; index: number } | null>(null)
  const current =
    matches.length === 0 ? -1 : selected?.query === query ? Math.min(selected.index, matches.length - 1) : start

  const reveal = async (index: number) => {
    const token = ++revealToken.current
    currentMark.current?.removeAttribute("data-current")
    currentMark.current = null
    const match = matches[index]
    // A copy, so moving back to the same match opens a disclosure the reader closed since.
    setTarget(match ? { ...match } : null)
    const list = listRef.current
    const row = match ? messages.findIndex((message) => message.id === match.messageId) : -1
    if (!match || !list || row === -1) return
    const mark = await scrollToMatch(list, row, match, ordinalInPart(matches, index))
    if (token !== revealToken.current || !mark) return
    mark.setAttribute("data-current", "")
    currentMark.current = mark
  }

  // Only a new query or start message moves the view; transcript updates while a turn streams must not.
  const revealFor = useEffectEvent((_query: string, _startMessageId: string | null) => void reveal(current))
  useEffect(() => {
    // A list that mounts together with the bar needs a frame to lay out before it can scroll.
    const frame = requestAnimationFrame(() => revealFor(query, startMessageId))
    return () => cancelAnimationFrame(frame)
  }, [query, startMessageId])

  useEffect(() => {
    const input = inputRef.current
    if (!input || focusRequest === handledFocusRequest) return
    handledFocusRequest = focusRequest
    if (document.activeElement !== input) returnFocus.current = document.activeElement
    input.focus()
    input.select()
  }, [focusRequest])

  useEffect(
    () => () => {
      revealToken.current++
      currentMark.current?.removeAttribute("data-current")
    },
    [],
  )

  const step = (delta: 1 | -1) => {
    if (matches.length === 0) return
    const index = (current + delta + matches.length) % matches.length
    setSelected({ query, index })
    void reveal(index)
  }

  const close = () => {
    closeFind()
    const target = returnFocus.current
    if (target instanceof HTMLElement && target.isConnected && target !== document.body) target.focus()
    else useUi.getState().requestComposerFocus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  }

  const pending = typed !== query
  const count =
    query.trim() === ""
      ? ""
      : matches.length === 0
        ? m.find_no_results()
        : m.find_count({ current: current + 1, total: matches.length })

  return (
    <search
      aria-label={m.find_label()}
      className="flex h-10 shrink-0 animate-fade-in items-center gap-1 border-b border-border px-3"
    >
      <RiSearchLine aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={typed}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={m.find_placeholder()}
        aria-label={m.find_label()}
        spellCheck={false}
        className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <output
        aria-live="polite"
        className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums aria-busy:opacity-60"
        aria-busy={pending}
      >
        {count}
      </output>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={m.find_previous()}
        title={m.find_previous()}
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <RiArrowUpSLine aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={m.find_next()}
        title={m.find_next()}
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <RiArrowDownSLine aria-hidden />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={m.find_close()} title={m.find_close()} onClick={close}>
        <RiCloseLine aria-hidden />
      </Button>
    </search>
  )
}
