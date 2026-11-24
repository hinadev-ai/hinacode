import { toast } from "sonner"
import type { PushEvent } from "../../shared/contract.ts"
import type { NotificationSettings } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { router } from "../router.tsx"
import { notify } from "./notify.ts"

type DevicesChanged = Extract<PushEvent, { type: "remote.devices.changed" }>

const WAITING_TAG = "remote-device-waiting"

const openRemoteSettings = () => void router.navigate({ to: "/settings", search: { page: "connections" } })

export const notifyDevicesChanged = (event: DevicesChanged, settings: NotificationSettings) => {
  if (event.reason === "approved" || event.reason === "reset") toast.dismiss(WAITING_TAG)
  const surface = document.hasFocus() ? "toast" : "desktop"
  if (event.reason === "enrolled" && settings.completed)
    notify(surface, {
      alert: "completed",
      title: m.remote_device_paired_notice({ name: event.name ?? "" }),
      body: m.remote_device_paired_notice_body(),
      sound: settings.sound,
      onClick: openRemoteSettings,
    })
  if (event.reason === "waiting" && settings.needsInput)
    notify(surface, {
      alert: "needsInput",
      title: m.remote_device_waiting_notice(),
      body: m.remote_device_waiting_notice_body(),
      sound: settings.sound,
      tag: WAITING_TAG,
      onClick: openRemoteSettings,
    })
}
