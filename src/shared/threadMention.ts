export const threadMention = (threadId: string) => `@thread:${threadId}`

export const THREAD_MENTION = /@thread:([\w-]+)/g

export const mentionedThreadId = (token: string): string | null => /^@thread:([\w-]+)$/.exec(token)?.[1] ?? null
