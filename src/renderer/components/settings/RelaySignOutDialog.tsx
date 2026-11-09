import { useAtomSet } from "@effect/atom-react"
import { useActionState } from "react"
import { errorMessage } from "../../lib/errorMessage.ts"
import { signOutRelayAtom } from "../../lib/rpc.ts"
import { inBrowser } from "../../lib/runtime.ts"
import { m } from "../../paraglide/messages.js"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog.tsx"

export function RelaySignOutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const signOut = useAtomSet(signOutRelayAtom, { mode: "promise" })
  const [error, run, isPending] = useActionState<string | null>(async () => {
    try {
      await signOut()
    } catch (cause) {
      return errorMessage(cause)
    }
    onOpenChange(false)
    return null
  }, null)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.environment_relay_sign_out_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {inBrowser() ? m.environment_relay_sign_out_body_web() : m.environment_relay_sign_out_body()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} action={run}>
            {m.environment_relay_sign_out()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
