import type { FsEntry } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx"

interface DeleteEntryDialogProps {
  readonly entry: FsEntry | null
  readonly onCancel: () => void
  readonly onDelete: (entry: FsEntry) => void
}

export function DeleteEntryDialog({ entry, onCancel, onDelete }: DeleteEntryDialogProps) {
  return (
    <AlertDialog open={entry !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.explorer_delete_title({ name: entry?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {entry?.kind === "dir" ? m.explorer_delete_folder_body() : m.explorer_delete_file_body()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => entry && onDelete(entry)}>
            {m.explorer_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
