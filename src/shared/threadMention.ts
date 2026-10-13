/** How a prompt names another thread. Agents read it with the kkcode `read_thread` tool. */
export const threadMention = (threadId: string) => `@thread:${threadId}`

/** Every thread mention in a text, with the thread id as group 1. */
export const THREAD_MENTION = /@thread:([\w-]+)/g

/** The thread id of a mention token, or null when `token` is not one. */
export const mentionedThreadId = (token: string): string | null => /^@thread:([\w-]+)$/.exec(token)?.[1] ?? null
