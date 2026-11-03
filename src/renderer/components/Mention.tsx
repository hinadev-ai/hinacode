import { Link } from "@tanstack/react-router"
import { createContext, type ReactElement, use } from "react"
import { MENTION, parseMention } from "../../shared/mentions.ts"
import { terminalLabel } from "../lib/terminalLabel.ts"
import { m } from "../paraglide/messages.js"
import { useTerminals } from "../stores/terminals.ts"
import { useThreads } from "../stores/threads.ts"
import { Highlighted } from "./FindHighlight.tsx"

export const MentionThread = createContext<string | null>(null)

const mentionClass = "text-syntax-token underline-offset-2 hover:underline"

function ThreadMention({ id, token }: { id: string; token: string }) {
  const thread = useThreads((state) => state.byId[id])
  if (thread === undefined) return <Highlighted text={token} />
  return (
    <Link to="/thread/$threadId" params={{ threadId: thread.id }} className={mentionClass}>
      <Highlighted text={`@${thread.title}`} />
    </Link>
  )
}

function TerminalMention({ id }: { id: string }) {
  const threadId = use(MentionThread)
  const sessions = useTerminals((state) => (threadId === null ? undefined : state.byThreadId[threadId]?.sessions))
  const index = sessions?.findIndex((session) => session.id === id) ?? -1
  const session = sessions?.[index]
  if (threadId === null || session === undefined)
    return <span className="text-muted-foreground">{m.terminal_mention_closed()}</span>
  return (
    <button type="button" onClick={() => useTerminals.getState().show(threadId, id)} className={mentionClass}>
      <Highlighted text={`@${terminalLabel(session, index)}`} />
    </button>
  )
}

export function Mention({ token }: { token: string }) {
  const mention = parseMention(token)
  if (mention === null) return <Highlighted text={token} />
  return mention.kind === "thread" ? (
    <ThreadMention id={mention.id} token={token} />
  ) : (
    <TerminalMention id={mention.id} />
  )
}

export function WithMentions({ text }: { text: string }) {
  const nodes: Array<ReactElement> = []
  let end = 0
  for (const match of text.matchAll(MENTION)) {
    nodes.push(<Highlighted key={`text-${end}`} text={text.slice(end, match.index)} />)
    nodes.push(<Mention key={`mention-${match.index}`} token={match[0]} />)
    end = match.index + match[0].length
  }
  nodes.push(<Highlighted key={`text-${end}`} text={text.slice(end)} />)
  return nodes
}
