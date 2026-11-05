export const windowsDrive = /^[a-zA-Z]:[\\/]/

export const isHomeRelative = (input: string) => input === "~" || input.startsWith("~/") || input.startsWith("~\\")

export const looksLikeDirectoryPath = (input: string) =>
  isHomeRelative(input) || input.startsWith("/") || windowsDrive.test(input)

export const separatorOf = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/")
