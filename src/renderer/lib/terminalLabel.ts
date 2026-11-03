import type { MentionableTerminal } from "../../shared/composerSyntax.ts"
import type { TerminalSession } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"

export const terminalLabel = (session: TerminalSession, index: number) =>
  session.title ?? m.terminal_tab({ index: index + 1 })

export const mentionableTerminals = (sessions: ReadonlyArray<TerminalSession>): ReadonlyArray<MentionableTerminal> =>
  sessions.map((session, index) => ({ session, label: terminalLabel(session, index) }))
