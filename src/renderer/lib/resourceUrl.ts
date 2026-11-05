import { webResourceUrl } from "../../shared/channels.ts"
import { inBrowser } from "./runtime.ts"

export const resourceUrl = (url: string) => (inBrowser() ? webResourceUrl(url) : url)

export const resourceSrcSet = (srcSet: string) =>
  inBrowser()
    ? srcSet
        .split(",")
        .map((entry) => entry.trim().replace(/^\S+/, webResourceUrl))
        .join(", ")
    : srcSet

export const servedSandbox = () => (inBrowser() ? "allow-scripts allow-same-origin" : "allow-scripts")
