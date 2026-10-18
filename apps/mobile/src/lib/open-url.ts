import { openURL } from "expo-linking"

/**
 * Opens a web page outside the app. Only http(s) URLs leave the app, as on the desktop, because a pull request
 * URL can arrive in a deep link and any other scheme could start another app.
 */
export function openWebUrl(url: string) {
  if (/^https?:\/\//i.test(url)) void openURL(url).catch(() => {})
}
