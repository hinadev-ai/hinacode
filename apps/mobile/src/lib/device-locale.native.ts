import { getLocales } from "expo-localization"

export const deviceLanguageTags = (): readonly string[] => getLocales().map((locale) => locale.languageTag)
