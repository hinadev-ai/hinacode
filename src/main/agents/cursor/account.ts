import type { AgentAccount } from "../../../shared/agent.ts"

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/

export const parseCursorStatus = (stdout: string): AgentAccount => {
  if (/not logged in/i.test(stdout)) return { type: "signedOut" }
  const email = EMAIL.exec(stdout)?.[0]
  if (email !== undefined) return { type: "subscription", email, plan: null, organization: null }
  return { type: "external", service: "Cursor" }
}
