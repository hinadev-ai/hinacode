import type { RpcEnvelope } from "../../src/shared/contract.ts"
import { defaultClientSettings, type ClientSettings, type Locale } from "../../src/shared/domain.ts"

export function desktopShim(locale: Locale) {
  let clientSettings: ClientSettings = {
    ...defaultClientSettings,
    locale,
    appearance: { ...defaultClientSettings.appearance, theme: "hina-light" },
  }
  const answers: Record<string, (payload: unknown) => unknown> = {
    "clientSettings.get": () => clientSettings,
    "clientSettings.set": (payload) => {
      clientSettings = { ...clientSettings, ...(payload as Partial<ClientSettings>) }
      return clientSettings
    },
    "app.ready": () => undefined,
    "app.focus": () => undefined,
    "app.setBadgeCount": () => undefined,
    "app.setColorScheme": () => undefined,
    "shell.openers": () => [],
    "environments.list": () => ({ clouds: [] }),
    "notifications.permission": () => "denied",
    "relayAccount.status": () => ({ state: "signedOut" }),
  }
  return (method: string, payload: unknown): RpcEnvelope<unknown> | undefined => {
    const answer = answers[method]
    return answer ? { result: answer(payload) } : undefined
  }
}
