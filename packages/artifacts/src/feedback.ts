import { z } from "zod"

export const CommentAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("developer") }),
  z.object({ kind: z.literal("agent"), threadId: z.string().optional() }),
])

export const CommentMessageSchema = z.object({
  id: z.string(),
  author: CommentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  undelivered: z.literal(true).optional(),
})

export const CommentAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact") }),
  z.object({
    kind: z.literal("text"),
    quote: z.string().refine((quote) => quote.trim() !== "", "A text anchor needs a quote."),
    prefix: z.string(),
    suffix: z.string(),
  }),
  z.object({ kind: z.literal("elements"), ids: z.array(z.string().min(1)).min(1, "Name at least one element.") }),
])

export const ArtifactCommentSchema = z.object({
  id: z.string(),
  anchor: CommentAnchorSchema,
  resolved: z.boolean(),
  messages: z.tuple([CommentMessageSchema], CommentMessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const ArtifactFeedbackSchema = z.object({
  comments: z.array(ArtifactCommentSchema).default([]),
})

export type CommentAuthor = z.infer<typeof CommentAuthorSchema>
export type CommentMessage = z.infer<typeof CommentMessageSchema>
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>
export type ArtifactComment = z.infer<typeof ArtifactCommentSchema>
export type ArtifactFeedback = z.infer<typeof ArtifactFeedbackSchema>

export const emptyFeedback = (): ArtifactFeedback => ({ comments: [] })

export const waitingOnDeveloper = (comment: ArtifactComment) =>
  !comment.resolved && comment.messages.at(-1)?.author.kind === "agent"
