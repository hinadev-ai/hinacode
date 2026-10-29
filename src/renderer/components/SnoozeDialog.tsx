import { Autocomplete } from "@base-ui/react/autocomplete"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useId, useRef, useState } from "react"
import { RiAlarmLine, RiAlarmSnoozeLine, RiCalendarLine } from "react-icons/ri"
import { toast } from "sonner"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { formatSnoozeTime, parseSnoozeTime, type SnoozePresetId, snoozePresets } from "../lib/snooze.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { returnFocus, useUi } from "../stores/ui.ts"
import { Dialog, DialogOverlay, DialogPortal } from "./ui/dialog.tsx"

interface Choice {
  readonly id: string
  readonly label: string
  readonly hint: string
  /** Null wakes the thread. */
  readonly until: Date | null
}

const presetLabels: Record<SnoozePresetId, () => string> = {
  inAnHour: m.snooze_in_an_hour,
  thisEvening: m.snooze_this_evening,
  tomorrow: m.snooze_tomorrow,
  nextWeek: m.snooze_next_week,
}

/** Sets or clears a thread's snooze, and offers to put the old one back. */
export async function snoozeThread(thread: Thread, until: Date | null) {
  const { upsert } = useThreads.getState()
  const update = (snoozedUntil: string | null) => callPromise("threads.update", { id: thread.id, snoozedUntil })
  try {
    upsert(await update(until?.toISOString() ?? null))
  } catch (cause) {
    toast.error((until ? m.snooze_failed : m.sidebar_unsnooze_failed)({ message: errorMessage(cause) }))
    return
  }
  if (!until) return
  toast(m.snooze_done({ time: formatSnoozeTime(until, new Date(), getLocale()) }), {
    action: {
      label: m.snooze_undo(),
      onClick: () =>
        void update(thread.snoozedUntil).then(upsert, (cause: unknown) =>
          toast.error(m.sidebar_unsnooze_failed({ message: errorMessage(cause) })),
        ),
    },
  })
}

const focusOnMount = (input: HTMLInputElement | null) => input?.focus()
const close = () => useUi.getState().setSnoozeThreadId(null)

// The snoozed row moves to another list, which can take the element focus went back to.
const keepFocus = () => {
  if (document.activeElement === document.body) useUi.getState().requestComposerFocus()
}

function SnoozePicker({ thread, onChoose }: { thread: Thread; onChoose: (until: Date | null) => void }) {
  const [text, setText] = useState("")
  const problemId = useId()
  const browsed = useRef(false)
  const now = new Date(useNow())
  const locale = getLocale()
  const parsed = parseSnoozeTime(text, now, locale)
  const snoozed = thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now.getTime()

  const choices: ReadonlyArray<Choice> = [
    ...(parsed.status === "ok"
      ? [
          {
            id: "typed",
            label: parsed.at.toLocaleString(locale, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
            hint: m.snooze_typed(),
            until: parsed.at,
          },
        ]
      : []),
    ...snoozePresets(now).map((preset) => ({
      id: preset.id,
      label: presetLabels[preset.id](),
      hint: formatSnoozeTime(preset.at, now, locale),
      until: preset.at,
    })),
    ...(snoozed ? [{ id: "wake", label: m.sidebar_thread_unsnooze(), hint: "", until: null }] : []),
  ]
  const problem =
    parsed.status === "unreadable" ? m.snooze_unreadable() : parsed.status === "past" ? m.snooze_past() : ""

  return (
    <>
      <DialogPrimitive.Title className="truncate px-3.5 pt-3 text-xs text-muted-foreground">
        {m.snooze_label({ title: thread.title })}
      </DialogPrimitive.Title>
      <Autocomplete.Root
        open
        inline
        items={choices}
        filter={null}
        autoHighlight={problem === "" ? "always" : false}
        keepHighlight
        value={text}
        onValueChange={(value, details) => {
          if (details.reason !== "item-press") setText(value)
          browsed.current = false
        }}
        onItemHighlighted={(_, details) => {
          browsed.current = details.reason === "keyboard"
        }}
        itemToStringValue={(choice: Choice) => choice.label}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <RiAlarmSnoozeLine aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Autocomplete.Input
            ref={focusOnMount}
            aria-label={m.snooze_input_label()}
            aria-describedby={problemId}
            placeholder={m.snooze_placeholder()}
            onKeyDown={(event) => {
              // The always-open list would otherwise take Escape for itself and keep the dialog up.
              if (event.key === "Escape") close()
              // With a problem shown, the highlight is left over from before it, and Enter must not quietly pick a
              // preset the person did not ask for. One they arrowed to after typing is theirs.
              if (event.key === "Enter" && problem !== "" && !browsed.current) event.preventBaseUIHandler()
            }}
            className="h-12 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <output id={problemId} className="block px-3.5 pt-2 text-xs text-muted-foreground empty:hidden">
          {problem}
        </output>
        <Autocomplete.List className="min-h-0 scroll-py-1 overflow-y-auto overscroll-contain p-1.5">
          {(choice: Choice) => (
            <Autocomplete.Item
              key={choice.id}
              value={choice}
              onClick={() => onChoose(choice.until)}
              className="flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:inset-ring data-highlighted:inset-ring-ring/50"
            >
              {choice.id === "typed" ? (
                <RiCalendarLine aria-hidden className="size-4 shrink-0" />
              ) : choice.until === null ? (
                <RiAlarmLine aria-hidden className="size-4 shrink-0" />
              ) : (
                <span aria-hidden className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{choice.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{choice.hint}</span>
            </Autocomplete.Item>
          )}
        </Autocomplete.List>
      </Autocomplete.Root>
    </>
  )
}

/** The snooze picker for the thread `useUi.snoozeThreadId` names. Mount once, in the app shell. */
export function SnoozeDialog() {
  const threadId = useUi((state) => state.snoozeThreadId)
  const thread = useThreads((state) => (threadId === null ? undefined : state.byId[threadId]))

  return (
    <Dialog open={thread !== undefined} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]">
          <DialogPrimitive.Popup
            finalFocus={returnFocus}
            className="flex max-h-[min(24rem,76dvh)] w-full max-w-md flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition-[opacity,scale] duration-150 ease-(--ease-out) data-starting-style:scale-98 data-starting-style:opacity-0"
          >
            {thread && (
              <SnoozePicker
                key={thread.id}
                thread={thread}
                onChoose={(until) => {
                  close()
                  void snoozeThread(thread, until).then(() => requestAnimationFrame(keepFocus))
                }}
              />
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    </Dialog>
  )
}
