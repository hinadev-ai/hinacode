import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { PRIVATE_NETWORKS } from "../../../shared/domain.ts"
import { type EnvironmentId, networkAddressesAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"

export const LOOPBACK = "127.0.0.1"

interface BindHostSelectProps {
  readonly id: string
  readonly environment: EnvironmentId
  readonly value: string
  readonly onChange: (bindHost: string) => void
  readonly privateNetworks?: boolean
}

export function BindHostSelect({ id, environment, value, onChange, privateNetworks = false }: BindHostSelectProps) {
  const addresses = AsyncResult.getOrElse(useAtomValue(networkAddressesAtom(environment)), () => [])
  const items = [
    ...(privateNetworks ? [{ value: PRIVATE_NETWORKS, label: m.settings_bind_private_networks() }] : []),
    ...addresses.map(({ name, address }) => ({ value: address, label: `${name} (${address})` })),
    { value: LOOPBACK, label: m.settings_bind_loopback() },
  ]
  if (!items.some((item) => item.value === value))
    items.push({ value, label: m.settings_bind_address_gone({ address: value }) })

  return (
    <Select items={items} value={value} onValueChange={(next) => typeof next === "string" && onChange(next)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
