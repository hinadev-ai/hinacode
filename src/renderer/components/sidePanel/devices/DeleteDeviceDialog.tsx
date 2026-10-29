import type { DevicePlatform } from "../../../../shared/device.ts"
import { m } from "../../../paraglide/messages.js"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog.tsx"

export interface DeviceToDelete {
  readonly name: string
  readonly platform: DevicePlatform
  readonly owned: boolean
}

export const deleteDeviceLabel = (platform: DevicePlatform) =>
  platform === "android" ? m.devices_delete_emulator() : m.devices_delete()

interface DeleteDeviceDialogProps {
  readonly device: DeviceToDelete | null
  readonly onCancel: () => void
  readonly onDelete: () => void
}

export function DeleteDeviceDialog({ device, onCancel, onDelete }: DeleteDeviceDialogProps) {
  return (
    <AlertDialog open={device !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.devices_delete_title({ name: device?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {device?.owned ? m.devices_delete_body() : m.devices_delete_body_any({ name: device?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>
            {device && deleteDeviceLabel(device.platform)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
