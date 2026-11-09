import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useState, useTransition } from "react"
import { RiUser3Line } from "react-icons/ri"
import { toast } from "sonner"
import { errorMessage } from "../lib/errorMessage.ts"
import { relayAccountAtom, signInRelayAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { RelaySignOutDialog } from "./settings/RelaySignOutDialog.tsx"
import { Button } from "./ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"

export function AccountMenu() {
  const status = AsyncResult.getOrElse(useAtomValue(relayAccountAtom), () => null)
  const signIn = useAtomSet(signInRelayAtom, { mode: "promise" })
  const [signingIn, startSignIn] = useTransition()
  const [signingOut, setSigningOut] = useState(false)
  const account = status?.state === "signedIn" ? status : null
  const identity = account?.name ?? account?.email ?? null

  const login = () =>
    startSignIn(async () => {
      try {
        await signIn()
      } catch (cause) {
        toast.error(m.account_sign_in_failed({ message: errorMessage(cause) }))
      }
    })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={m.account_menu_label()}
              className={cn("ml-auto rounded-full", account && "border border-sidebar-border")}
            />
          }
        >
          {account?.avatar ? (
            <img alt="" src={account.avatar} className="size-full rounded-full object-cover" />
          ) : identity ? (
            <span aria-hidden className="text-xs font-medium uppercase">
              {identity.slice(0, 1)}
            </span>
          ) : (
            <RiUser3Line aria-hidden className={cn(signingIn && "animate-pulse")} />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {identity && (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">{identity}</DropdownMenuLabel>
            </DropdownMenuGroup>
          )}
          {account === null && (
            <DropdownMenuItem onClick={login}>
              {signingIn ? m.account_menu_waiting() : m.account_menu_login()}
            </DropdownMenuItem>
          )}
          <DropdownMenuLinkItem closeOnClick render={<Link to="/settings" search={{ page: "connections" }} />}>
            {m.account_menu_connected_devices()}
          </DropdownMenuLinkItem>
          <DropdownMenuLinkItem closeOnClick render={<Link to="/settings" />}>
            {m.account_menu_settings()}
          </DropdownMenuLinkItem>
          {account && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSigningOut(true)}>{m.account_menu_logout()}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <RelaySignOutDialog open={signingOut} onOpenChange={setSigningOut} />
    </>
  )
}
