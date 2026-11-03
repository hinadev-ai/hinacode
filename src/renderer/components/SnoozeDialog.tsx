import { toast } from "sonner"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { formatSnoozeTime } from "../lib/snooze.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { AlarmIcon } from "./icons/AlarmIcon.tsx"
import { SnoozeIcon } from "./icons/SnoozeIcon.tsx"
import { TimePickerDialog } from "./TimePickerDialog.tsx"

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
      label: m.common_undo(),
      onClick: () =>
        void update(thread.snoozedUntil).then(upsert, (cause: unknown) =>
          toast.error(m.sidebar_unsnooze_failed({ message: errorMessage(cause) })),
        ),
    },
  })
}

const close = () => useUi.getState().setSnoozeThreadId(null)

const keepFocus = () => {
  if (document.activeElement === document.body) useUi.getState().requestComposerFocus()
}

export function SnoozeDialog() {
  const threadId = useUi((state) => state.snoozeThreadId)
  const thread = useThreads((state) => (threadId === null ? undefined : state.byId[threadId]))

  return (
    <TimePickerDialog
      open={thread !== undefined}
      title={m.snooze_label({ title: thread?.title ?? "" })}
      inputLabel={m.snooze_input_label()}
      placeholder={m.snooze_placeholder()}
      icon={SnoozeIcon}
      extraChoices={(now) =>
        thread?.snoozedUntil != null && Date.parse(thread.snoozedUntil) > now.getTime()
          ? [{ id: "wake", label: m.sidebar_thread_unsnooze(), hint: "", at: null, icon: AlarmIcon }]
          : []
      }
      onClose={close}
      onChoose={(until) => {
        if (thread === undefined) return
        close()
        void snoozeThread(thread, until).then(() => requestAnimationFrame(keepFocus))
      }}
    />
  )
}
