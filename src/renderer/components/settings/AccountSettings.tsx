import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useId, useState, useTransition } from "react"
import { RiAddLine, RiDeleteBinLine, RiMoreFill, RiPencilLine } from "react-icons/ri"
import { AccountProviderId, type AgentAccount, type AgentProfile, type ProviderId } from "../../../shared/agent.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import {
  accountAtom,
  accountKey,
  accountsAtom,
  createAccountAtom,
  deleteAccountAtom,
  renameAccountAtom,
  updateSettingsAtom,
} from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useMenuAction } from "../../lib/useMenuAction.ts"
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
import { providerLabel } from "../ProviderIcon.tsx"
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

const signedOutHint = {
  claude: m.settings_account_signed_out_claude,
  codex: m.settings_account_signed_out_codex,
  muse: m.settings_account_signed_out_muse,
} satisfies Record<ProviderId, () => string>

const addsAccounts = Schema.is(AccountProviderId)

const configDirVariable = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } satisfies Record<
  AccountProviderId,
  string
>

const shellQuote = (value: string) => (/^[\w./~-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)

/** What the user runs in a terminal to sign the account in. */
const loginCommand = (account: AgentProfile) =>
  [
    `${configDirVariable[account.provider]}=${shellQuote(account.configDir)}`,
    shellQuote(account.binary),
    ...(account.provider === "claude" ? ["auth", "login"] : ["login"]),
  ].join(" ")

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
      {addsAccounts(provider) && (
        <>
          <div>
            <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setAdding(true)}>
              <RiAddLine aria-hidden />
              {m.settings_account_add()}
            </Button>
          </div>
          <AddAccountDialog provider={provider} open={adding} onOpenChange={setAdding} />
        </>
      )}
    </div>
  )
}

type RowDialog = "rename" | "remove"

function AccountRow({ account }: { account: AgentProfile }) {
  const status = useAtomValue(accountAtom(accountKey(account.provider, account.id)))
  const refreshStatus = useAtomRefresh(accountAtom(accountKey(account.provider, account.id)))
  const [dialog, setDialog] = useState<RowDialog | null>(null)
  const menuAction = useMenuAction<RowDialog>(setDialog)
  const signedOut = AsyncResult.isSuccess(status) && status.value.type === "signedOut"

  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null)
  }

  return (
    <li className="flex flex-col pb-1">
      <div className="flex min-h-8 items-center gap-x-3">
        <span className="w-28 shrink-0 truncate text-sm font-medium">{account.name}</span>
        <AccountStatus provider={account.provider} account={account} />
        <DropdownMenu onOpenChangeComplete={menuAction.onOpenChangeComplete}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label={m.settings_account_actions({ name: account.name })}
              />
            }
          >
            <RiMoreFill aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => menuAction.queue("rename")}>
              <RiPencilLine aria-hidden />
              {m.settings_account_rename()}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => menuAction.queue("remove")}>
              <RiDeleteBinLine aria-hidden />
              {m.settings_account_remove()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex min-w-0 flex-col gap-1 pl-31">
        <p className="truncate font-mono text-xs text-muted-foreground" title={account.configDir}>
          {account.configDir}
        </p>
        {signedOut && (
          <div className="flex min-w-0 flex-col items-start gap-1 text-xs">
            <span className="text-muted-foreground">{m.settings_account_sign_in_terminal()}</span>
            <code className="max-w-full rounded-md bg-muted px-2 py-1 font-mono break-all select-all">
              {loginCommand(account)}
            </code>
            <Button variant="ghost" size="xs" className="-ml-2" onClick={refreshStatus}>
              {m.settings_account_check_again()}
            </Button>
          </div>
        )}
      </div>
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
      return cliLogin ? signedOutHint[provider]() : m.settings_account_signed_out()
  }
}

interface AddAccountDialogProps {
  readonly provider: AccountProviderId
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function AddAccountDialog({ provider, open, onOpenChange }: AddAccountDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Inside the popup so every opening starts from an empty form. */}
        <AddAccountForm provider={provider} onCreated={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AddAccountForm({ provider, onCreated }: { provider: AccountProviderId; onCreated: () => void }) {
  const createAccount = useAtomSet(createAccountAtom, { mode: "promise" })
  const [name, setName] = useState("")
  const [binary, setBinary] = useState<string>(provider)
  const [configDir, setConfigDir] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const nameId = useId()
  const binaryId = useId()
  const configDirId = useId()
  const complete = [name, binary, configDir].every((value) => value.trim() !== "")

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        await createAccount({ provider, name: name.trim(), binary: binary.trim(), configDir: configDir.trim() })
        onCreated()
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
        <FieldLabel htmlFor={nameId}>{m.account_dialog_name()}</FieldLabel>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={m.account_dialog_name_placeholder()}
          maxLength={80}
          autoComplete="off"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={binaryId}>{m.account_dialog_binary()}</FieldLabel>
        <Input
          id={binaryId}
          value={binary}
          onChange={(event) => setBinary(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
        <FieldDescription>
          {m.account_dialog_binary_description({ provider: providerLabel[provider]() })}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={configDirId}>{m.account_dialog_config_dir()}</FieldLabel>
        <Input
          id={configDirId}
          value={configDir}
          onChange={(event) => setConfigDir(event.target.value)}
          placeholder={`~/.${provider}-work`}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
        <FieldDescription>
          {m.account_dialog_config_dir_description({ variable: configDirVariable[provider] })}
        </FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={!complete || pending}>
          {m.settings_account_add()}
        </Button>
      </DialogFooter>
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
