import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useEffect, useEffectEvent, useId, useState, useTransition } from "react"
import { RiAddLine, RiDeleteBinLine, RiLoginBoxLine, RiLogoutBoxLine, RiMoreFill, RiPencilLine } from "react-icons/ri"
import type { AgentAccount, AgentProfile, ProviderId } from "../../../shared/agent.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import {
  accountAtom,
  accountKey,
  accountsAtom,
  callPromise,
  createAccountAtom,
  deleteAccountAtom,
  onPushEvent,
  renameAccountAtom,
  updateSettingsAtom,
} from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
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
import { Button } from "../ui/button.tsx"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"

export const providerLabel = { claude: m.provider_claude, codex: m.provider_codex } satisfies Record<
  ProviderId,
  () => string
>
const signedOutHint = {
  claude: m.settings_account_signed_out_claude,
  codex: m.settings_account_signed_out_codex,
} satisfies Record<ProviderId, () => string>

/** The provider's added accounts, in the order they were added. */
export function useProviderAccounts(provider: ProviderId): ReadonlyArray<AgentProfile> {
  const all = AsyncResult.getOrElse(useAtomValue(accountsAtom), (): ReadonlyArray<AgentProfile> => [])
  return all.filter((account) => account.provider === provider)
}

/** The CLI's own login, then every account added for `provider`, each with who it is signed in as. */
export function AccountList({ provider }: { provider: ProviderId }) {
  const accounts = useProviderAccounts(provider)
  const [adding, setAdding] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={m.settings_accounts_label({ provider: providerLabel[provider]() })} className="flex flex-col">
        <li className="flex min-h-8 items-center gap-3">
          <span className="w-28 shrink-0 truncate text-sm">{m.account_cli_login()}</span>
          <AccountStatus provider={provider} account={null} />
        </li>
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
      </ul>
      <div>
        <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setAdding(true)}>
          <RiAddLine aria-hidden />
          {m.settings_account_add()}
        </Button>
      </div>
      <AccountDialog provider={provider} account={null} open={adding} onOpenChange={setAdding} />
    </div>
  )
}

type RowDialog = "signIn" | "rename" | "remove"

function AccountRow({ account }: { account: AgentProfile }) {
  const status = useAtomValue(accountAtom(accountKey(account.provider, account.id)))
  const refreshStatus = useAtomRefresh(accountAtom(accountKey(account.provider, account.id)))
  const [dialog, setDialog] = useState<RowDialog | null>(null)
  const [queued, setQueued] = useState<RowDialog | "signOut" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const signedIn = AsyncResult.isSuccess(status) && status.value.type !== "signedOut"

  const signOut = async () => {
    setError(null)
    try {
      await callPromise("accounts.signOut", { id: account.id })
    } catch (cause) {
      setError(errorMessage(cause))
    }
    refreshStatus()
  }

  // Menu items queue their action and run it once the menu has closed and handed focus back.
  const runQueued = () => {
    if (queued === "signOut") void signOut()
    else setDialog(queued)
    setQueued(null)
  }
  const closeDialog = (open: boolean) => {
    if (open) return
    setDialog(null)
    refreshStatus()
  }

  return (
    <li className="flex min-h-8 flex-wrap items-center gap-x-3">
      <span className="w-28 shrink-0 truncate text-sm font-medium">{account.name}</span>
      <AccountStatus provider={account.provider} account={account} />
      <div className="ml-auto flex items-center gap-1">
        {AsyncResult.isSuccess(status) && !signedIn && (
          <Button variant="outline" size="sm" onClick={() => setDialog("signIn")}>
            <RiLoginBoxLine aria-hidden />
            {m.settings_account_sign_in()}
          </Button>
        )}
        <DropdownMenu
          onOpenChange={(open) => open && setError(null)}
          onOpenChangeComplete={(open) => {
            if (!open && queued) runQueued()
          }}
        >
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={m.settings_account_actions({ name: account.name })} />
            }
          >
            <RiMoreFill aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setQueued("rename")}>
              <RiPencilLine aria-hidden />
              {m.settings_account_rename()}
            </DropdownMenuItem>
            {signedIn && (
              <DropdownMenuItem onClick={() => setQueued("signOut")}>
                <RiLogoutBoxLine aria-hidden />
                {m.settings_account_sign_out()}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onClick={() => setQueued("remove")}>
              <RiDeleteBinLine aria-hidden />
              {m.settings_account_remove()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && <FieldError className="basis-full">{error}</FieldError>}
      <AccountDialog
        provider={account.provider}
        account={account}
        open={dialog === "signIn"}
        onOpenChange={closeDialog}
      />
      <RenameAccountDialog account={account} open={dialog === "rename"} onOpenChange={closeDialog} />
      <RemoveAccountDialog account={account} open={dialog === "remove"} onOpenChange={closeDialog} />
    </li>
  )
}

/** `account` null is the CLI's own login. */
export function AccountStatus({ provider, account }: { provider: ProviderId; account: AgentProfile | null }) {
  const status = useAtomValue(accountAtom(accountKey(provider, account?.id ?? null)))
  return (
    <output
      aria-label={
        account === null
          ? m.settings_account_label({ provider: providerLabel[provider]() })
          : m.settings_account_named_label({ name: account.name })
      }
      className="flex min-w-0 flex-wrap gap-x-1.5 text-sm text-muted-foreground"
    >
      {AsyncResult.builder(status)
        .onInitial(() => m.settings_account_loading())
        .onSuccess((current) => describeAccount(provider, current, account === null))
        .onError((cause) => m.settings_account_failed({ message: errorMessage(cause) }))
        .orElse(() => null)}
    </output>
  )
}

function describeAccount(provider: ProviderId, account: AgentAccount, cliLogin: boolean) {
  switch (account.type) {
    case "subscription": {
      const details = [account.plan, account.organization].filter((detail) => detail !== null)
      return (
        <>
          <span className="text-foreground">
            {account.email === null
              ? m.settings_account_signed_in_no_email()
              : m.settings_account_signed_in({ email: account.email })}
          </span>
          {details.map((detail) => (
            <span key={detail}>
              <span aria-hidden>· </span>
              {detail}
            </span>
          ))}
        </>
      )
    }
    case "apiKey":
      return m.settings_account_api_key()
    case "external":
      return m.settings_account_external({ service: account.service })
    case "signedOut":
      // Only the CLI's own login is signed in from a terminal; added accounts sign in here.
      return cliLogin ? signedOutHint[provider]() : m.settings_account_signed_out()
  }
}

interface AccountDialogProps {
  readonly provider: ProviderId
  /** Null adds a new account first. */
  readonly account: AgentProfile | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

/** Names a new account, then signs it in. With an existing account it only signs in. */
function AccountDialog({ provider, account, open, onOpenChange }: AccountDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Inside the popup so every opening starts from the first step. */}
        <AccountDialogSteps provider={provider} initial={account} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AccountDialogSteps({
  provider,
  initial,
  onDone,
}: {
  provider: ProviderId
  initial: AgentProfile | null
  onDone: () => void
}) {
  const [account, setAccount] = useState(initial)
  // A retry remounts the step, which starts a fresh sign-in.
  const [attempt, setAttempt] = useState(0)
  return account === null ? (
    <NameStep provider={provider} onCreated={setAccount} />
  ) : (
    <SignInStep key={attempt} account={account} onSignedIn={onDone} onRetry={() => setAttempt((count) => count + 1)} />
  )
}

function NameStep({ provider, onCreated }: { provider: ProviderId; onCreated: (account: AgentProfile) => void }) {
  const createAccount = useAtomSet(createAccountAtom, { mode: "promise" })
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const inputId = useId()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        onCreated(await createAccount({ provider, name: name.trim() }))
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{m.account_dialog_add_title({ provider: providerLabel[provider]() })}</DialogTitle>
        <DialogDescription>{m.account_dialog_add_description()}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={inputId}>{m.account_dialog_name()}</FieldLabel>
        <Input
          id={inputId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={m.account_dialog_name_placeholder()}
          maxLength={80}
          autoComplete="off"
        />
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={name.trim() === "" || pending}>
          {m.account_dialog_continue()}
        </Button>
      </DialogFooter>
    </form>
  )
}

type SignInState =
  | { readonly type: "starting" }
  | { readonly type: "waiting"; readonly url: string; readonly acceptsCode: boolean }
  | { readonly type: "failed"; readonly message: string }

interface SignInStepProps {
  readonly account: AgentProfile
  readonly onSignedIn: () => void
  readonly onRetry: () => void
}

/** Starts the sign-in on mount, and abandons it if the dialog closes before the agent has the login. */
function SignInStep({ account, onSignedIn, onRetry }: SignInStepProps) {
  const [state, setState] = useState<SignInState>({ type: "starting" })
  const signedIn = useEffectEvent(onSignedIn)

  useEffect(() => {
    let finished = false
    const stop = onPushEvent((event) => {
      if (event.type !== "account.signIn" || event.accountId !== account.id) return
      finished = true
      if (event.error === null) signedIn()
      else setState({ type: "failed", message: event.error })
    })
    callPromise("accounts.signIn", { id: account.id }).then(
      ({ url, acceptsCode }) => !finished && setState({ type: "waiting", url, acceptsCode }),
      (cause) => {
        finished = true
        setState({ type: "failed", message: errorMessage(cause) })
      },
    )
    return () => {
      stop()
      if (!finished) void callPromise("accounts.cancelSignIn", { id: account.id })
    }
  }, [account.id])

  const provider = providerLabel[account.provider]()
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{m.account_sign_in_title({ name: account.name })}</DialogTitle>
        <DialogDescription>{m.account_sign_in_waiting({ provider })}</DialogDescription>
      </DialogHeader>
      {state.type === "waiting" && (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              className="w-fit text-sm text-primary underline-offset-4 hover:underline focus-visible:underline"
            >
              {m.account_sign_in_link()}
            </a>
            <p className="truncate font-mono text-xs text-muted-foreground select-all" title={state.url}>
              {state.url}
            </p>
          </div>
          {state.acceptsCode && <CodeForm accountId={account.id} />}
        </>
      )}
      {state.type === "starting" && (
        <output className="text-sm text-muted-foreground">{m.account_sign_in_starting()}</output>
      )}
      {state.type === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          {m.account_sign_in_failed({ message: state.message })}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
        {state.type === "failed" && <Button onClick={onRetry}>{m.common_retry()}</Button>}
      </DialogFooter>
    </div>
  )
}

function CodeForm({ accountId }: { accountId: string }) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const inputId = useId()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        await callPromise("accounts.submitCode", { id: accountId, code: code.trim() })
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <form onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor={inputId}>{m.account_sign_in_code()}</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
          <Button type="submit" variant="outline" disabled={code.trim() === "" || pending}>
            {m.account_sign_in_submit_code()}
          </Button>
        </div>
        <FieldDescription>{m.account_sign_in_code_hint()}</FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  )
}

interface AccountDialogBaseProps {
  readonly account: AgentProfile
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function RenameAccountDialog({ account, open, onOpenChange }: AccountDialogBaseProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <RenameForm account={account} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({ account, onSaved }: { account: AgentProfile; onSaved: () => void }) {
  const renameAccount = useAtomSet(renameAccountAtom, { mode: "promise" })
  const [name, setName] = useState(account.name)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const inputId = useId()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        await renameAccount({ id: account.id, name: name.trim() })
        onSaved()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{m.account_dialog_rename_title({ name: account.name })}</DialogTitle>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={inputId}>{m.account_dialog_name()}</FieldLabel>
        <Input
          id={inputId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoComplete="off"
        />
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={name.trim() === "" || name.trim() === account.name || pending}>
          {m.account_dialog_save()}
        </Button>
      </DialogFooter>
    </form>
  )
}

function RemoveAccountDialog({ account, open, onOpenChange }: AccountDialogBaseProps) {
  const deleteAccount = useAtomSet(deleteAccountAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const remove = () =>
    startTransition(async () => {
      setError(null)
      try {
        await deleteAccount(account.id)
        onOpenChange(false)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(isOpen) => isOpen || setError(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.account_remove_title({ name: account.name })}</AlertDialogTitle>
          <AlertDialogDescription>{m.account_remove_body()}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={remove}>
            {m.account_remove_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const CLI_LOGIN = "cli"

/** Which account new threads of `provider` start on. Hidden until the provider has an added account. */
export function DefaultAccountField({ provider }: { provider: ProviderId }) {
  const accounts = useProviderAccounts(provider)
  const { defaultAccount } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const inputId = `default-account-${provider}`
  if (accounts.length === 0) return null
  const items = [
    { value: CLI_LOGIN, label: m.account_cli_login() },
    ...accounts.map((account) => ({ value: account.id, label: account.name })),
  ]

  const save = async (value: string | null) => {
    if (value === null) return
    setError(null)
    try {
      await updateSettings({ defaultAccount: { ...defaultAccount, [provider]: value === CLI_LOGIN ? null : value } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{m.settings_default_account()}</FieldLabel>
      <div>
        <Select items={items} value={defaultAccount[provider] ?? CLI_LOGIN} onValueChange={(next) => void save(next)}>
          <SelectTrigger id={inputId} className="w-72">
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
      </div>
      <FieldDescription>{m.settings_default_account_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
