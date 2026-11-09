export interface ClerkAppearance {
  readonly variables: Readonly<Record<string, string>>
  readonly elements: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export interface ClerkSignInOptions {
  readonly forceRedirectUrl: string
  readonly signUpForceRedirectUrl: string
  readonly appearance: ClerkAppearance
}

export interface Clerk {
  readonly isSignedIn: boolean
  readonly session: { readonly getToken: () => Promise<string | null> } | null | undefined
  readonly load: (options: { readonly ui: { readonly ClerkUI: unknown } }) => Promise<void>
  readonly mountSignIn: (element: HTMLElement, options: ClerkSignInOptions) => void
  readonly unmountSignIn: (element: HTMLElement) => void
  readonly signOut: () => Promise<void>
}

declare global {
  interface Window {
    Clerk?: Clerk
    __internal_ClerkUICtor?: unknown
  }
}

const frontendHost = (publishableKey: string) => atob(publishableKey.split("_")[2] ?? "").replace(/\$$/, "")

const loadScript = (src: string, attributes: Readonly<Record<string, string>> = {}) =>
  new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = src
    script.crossOrigin = "anonymous"
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value)
    script.addEventListener("load", () => resolve())
    script.addEventListener("error", () => {
      script.remove()
      reject(new Error(`Could not load ${src}`))
    })
    document.head.append(script)
  })

const load = async (publishableKey: string) => {
  const host = frontendHost(publishableKey)
  await Promise.all([
    loadScript(`https://${host}/npm/@clerk/ui@1/dist/ui.browser.js`),
    loadScript(`https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      "data-clerk-publishable-key": publishableKey,
    }),
  ])
  const clerk = window.Clerk
  if (clerk === undefined) throw new Error("clerk-js loaded without starting Clerk")
  await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })
  return clerk
}

const loading = new Map<string, Promise<Clerk>>()

export const loadClerk = (publishableKey: string) => {
  const cached = loading.get(publishableKey)
  if (cached !== undefined) return cached
  const clerk = load(publishableKey)
  loading.set(publishableKey, clerk)
  clerk.catch(() => loading.delete(publishableKey))
  return clerk
}
