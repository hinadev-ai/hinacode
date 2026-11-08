import { z } from "zod"

export const VerifyPaneSchema = z.union([
  z.strictObject({ label: z.string().optional(), artifactId: z.string() }),
  z.strictObject({ label: z.string().optional(), path: z.string() }),
])

export const VerifySpecSchema = z.object({
  notes: z.string().optional(),
  expected: z.array(VerifyPaneSchema),
  actual: z.array(VerifyPaneSchema),
})

export type VerifyPane = z.infer<typeof VerifyPaneSchema>
export type VerifySpec = z.infer<typeof VerifySpecSchema>
