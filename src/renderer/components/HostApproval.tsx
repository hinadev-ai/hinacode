import { useAtomSet } from "@effect/atom-react"
import type { Cloud } from "../lib/environments.ts"
import { confirmHostAtom, repairEnvironmentAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"

export function ConfirmHostButtons({ cloud }: { cloud: Pick<Cloud, "id" | "approval"> }) {
  const confirm = useAtomSet(confirmHostAtom, { mode: "promise" })
  if (cloud.approval?.accepted !== true) return null
  const answer = (accepted: boolean) => () =>
    confirm({ id: cloud.id, accepted }).then(
      () => undefined,
      () => undefined,
    )
  return (
    <>
      <Button type="button" size="sm" action={answer(true)}>
        {m.environment_confirm_yes()}
      </Button>
      <Button type="button" variant="outline" size="sm" action={answer(false)}>
        {m.environment_confirm_no()}
      </Button>
    </>
  )
}

export function RepairButton({ cloud }: { cloud: Pick<Cloud, "id"> }) {
  const repair = useAtomSet(repairEnvironmentAtom, { mode: "promise" })
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      action={() =>
        repair(cloud.id).then(
          () => undefined,
          () => undefined,
        )
      }
    >
      {m.environment_pair_again()}
    </Button>
  )
}
