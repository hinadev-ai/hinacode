export const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
