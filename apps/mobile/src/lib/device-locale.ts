export const deviceLanguageTags = (): readonly string[] =>
  typeof window === "undefined" ? [] : navigator.languages
