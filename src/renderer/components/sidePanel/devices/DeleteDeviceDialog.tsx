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

interface DeleteDeviceDialogProps {
  /** The simulator to delete, or null while the dialog is closed. */
  readonly name: string | null
  readonly onCancel: () => void
  readonly onDelete: () => void
}

/** Confirms deleting a simulator HinaCode created for the thread, which detaching it does. */
export function DeleteDeviceDialog({ name, onCancel, onDelete }: DeleteDeviceDialogProps) {
  return (
    <AlertDialog open={name !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.devices_delete_title({ name: name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>{m.devices_delete_body()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>
            {m.devices_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
