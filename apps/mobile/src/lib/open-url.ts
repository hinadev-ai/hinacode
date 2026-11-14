import { openURL } from "expo-linking"

// oxlint-disable-next-line hinacode/no-comments
// A pull request URL can arrive in a deep link, and any scheme but http(s) could start another app.
export function openWebUrl(url: string) {
  if (/^https?:\/\//i.test(url)) void openURL(url).catch(() => {})
}
