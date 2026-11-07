import { Suspense, startTransition, use, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button.tsx"
import { Input } from "@/components/ui/input.tsx"
import { windowEntry } from "@/lib/windowEntry.ts"
import { m } from "@/paraglide/messages.js"
import icon from "../../../assets/icon.svg"
import {
  type Approval,
  chooseRelay,
  DEFAULT_RELAY_URL,
  type OnSignedIn,
  openSignIn,
  type SignInAttempt,
  type SignInStep,
  switchAccount,
} from "./account.ts"
import type { Clerk, ClerkAppearance } from "./clerk.ts"

export function Gate({
  error,
  initialAttempt,
  onSignedIn,
}: {
  readonly error: string | null
  readonly initialAttempt: SignInAttempt
  readonly onSignedIn: OnSignedIn
}) {
  const [attempt, setAttempt] = useState(initialAttempt)
  const open = (serviceUrl: string) => setAttempt(openSignIn(serviceUrl, onSignedIn))

  return (
    <main className="grid min-h-dvh content-start justify-items-center gap-8 bg-background px-4 pt-16 pb-8 text-foreground">
      <article className="w-full max-w-md rounded-2xl border bg-card px-8 pt-12 pb-8 text-center text-card-foreground shadow-sm max-sm:px-5 max-sm:pt-8 max-sm:pb-5">
        <img src={icon} alt="" className="mx-auto mb-8 size-14 rounded-xl ring-1 ring-border" />
        <h1 className="text-xl font-semibold text-balance">{m.web_sign_in_title()}</h1>
        <Suspense>
          <Step step={attempt.step} error={error} retry={() => open(attempt.serviceUrl)} />
        </Suspense>
      </article>
      <RelayForm
        serviceUrl={attempt.serviceUrl}
        open={(serviceUrl) => {
          chooseRelay(serviceUrl)
          location.reload()
        }}
      />
    </main>
  )
}

function Step({
  step,
  error,
  retry,
}: {
  readonly step: Promise<SignInStep>
  readonly error: string | null
  readonly retry: () => void
}) {
  const current = use(step)
  switch (current._tag) {
    case "failed":
      return <Failure message={current.message} retry={retry} />
    case "signIn":
      return (
        <>
          <ErrorText error={error} />
          <ClerkSignIn clerk={current.clerk} />
        </>
      )
    case "signingIn":
      return (
        <Suspense fallback={<SigningIn />}>
          <Device approval={current.approval} clerk={current.clerk} retry={retry} />
        </Suspense>
      )
  }
}

function Device({
  approval,
  clerk,
  retry,
}: {
  readonly approval: Promise<Approval>
  readonly clerk: Clerk
  readonly retry: () => void
}) {
  const result = use(approval)
  if (result._tag === "signedIn") return <SigningIn />
  return (
    <Failure
      message={result.message}
      retry={retry}
      changeAccount={async () => {
        await switchAccount(clerk)
        location.reload()
      }}
    />
  )
}

function SigningIn() {
  return <output className="mt-3 block text-muted-foreground">{m.web_signing_in()}</output>
}

function Failure({
  message,
  retry,
  changeAccount,
}: {
  readonly message: string
  readonly retry: () => void
  readonly changeAccount?: () => Promise<void>
}) {
  return (
    <>
      <ErrorText error={message} />
      <div className="mt-8 grid gap-2">
        <Button size="lg" action={retry}>
          {m.common_retry()}
        </Button>
        {changeAccount && (
          <Button size="lg" variant="ghost" action={changeAccount}>
            {m.web_switch_account()}
          </Button>
        )}
      </div>
    </>
  )
}

function ErrorText({ error }: { readonly error: string | null }) {
  if (error === null) return null
  return (
    <p role="alert" className="mt-3 text-sm text-pretty wrap-anywhere text-destructive">
      {error}
    </p>
  )
}

function ClerkSignIn({ clerk }: { readonly clerk: Clerk }) {
  const target = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = target.current
    if (element === null) return
    const returnUrl = new URL(location.pathname, location.origin)
    if (windowEntry !== null) returnUrl.searchParams.set("entry", windowEntry)
    clerk.mountSignIn(element, {
      forceRedirectUrl: returnUrl.href,
      signUpForceRedirectUrl: returnUrl.href,
      appearance: signInAppearance(element),
    })
    return () => clerk.unmountSignIn(element)
  }, [clerk])
  return (
    <div className="mt-8 text-start">
      <div ref={target} />
    </div>
  )
}

const themeColors = (within: HTMLElement) => {
  const probe = within.appendChild(document.createElement("span"))
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const paint = canvas.getContext("2d", { willReadFrequently: true })
  const read = (token: string) => {
    probe.style.color = `var(${token})`
    const color = getComputedStyle(probe).color
    if (paint === null) return color
    paint.clearRect(0, 0, 1, 1)
    paint.fillStyle = color
    paint.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0, alpha = 255] = paint.getImageData(0, 0, 1, 1).data
    return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`
  }
  const colors = {
    primary: read("--primary"),
    onPrimary: read("--primary-foreground"),
    background: read("--card"),
    text: read("--card-foreground"),
    muted: read("--muted-foreground"),
    input: read("--background"),
    border: read("--border"),
  }
  probe.remove()
  return colors
}

const signInAppearance = (within: HTMLElement): ClerkAppearance => {
  const colors = themeColors(within)
  return {
    variables: {
      colorPrimary: colors.primary,
      colorPrimaryForeground: colors.onPrimary,
      colorBackground: colors.background,
      colorForeground: colors.text,
      colorMutedForeground: colors.muted,
      colorInput: colors.input,
      colorInputForeground: colors.text,
      colorNeutral: colors.text,
      colorBorder: colors.border,
      fontFamily: "inherit",
      borderRadius: "10px",
    },
    elements: {
      rootBox: { width: "100%" },
      cardBox: {
        width: "100%",
        maxWidth: "none",
        boxShadow: "none",
        border: "none",
        borderRadius: "0",
        background: "transparent",
      },
      card: { boxShadow: "none", border: "none", background: "transparent", padding: "0" },
      header: { display: "none" },
      footer: { background: "transparent" },
      socialButtonsBlockButton: {
        height: "44px",
        boxShadow: "none",
        border: `1px solid ${colors.border}`,
        background: colors.input,
      },
      socialButtonsBlockButtonText: { color: colors.text, fontWeight: "500", fontSize: "0.9375rem" },
    },
  }
}

function RelayForm({ serviceUrl, open }: { readonly serviceUrl: string; readonly open: (serviceUrl: string) => void }) {
  const [showRelay, setShowRelay] = useState(
    serviceUrl !== DEFAULT_RELAY_URL || DEFAULT_RELAY_URL !== "https://relay.hinacode.app",
  )
  if (!showRelay)
    return (
      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        onClick={() => startTransition(() => setShowRelay(true))}
      >
        {m.web_use_other_relay()}
      </button>
    )
  return (
    <form
      action={(form) => open(String(form.get("serviceUrl") || DEFAULT_RELAY_URL))}
      className="flex w-full max-w-md items-end gap-2"
    >
      <label className="flex flex-1 flex-col gap-1.5 text-sm">
        {m.web_relay_url()}
        <Input name="serviceUrl" type="url" defaultValue={serviceUrl} required />
      </label>
      <Button type="submit" variant="outline">
        {m.web_use_relay()}
      </Button>
    </form>
  )
}
