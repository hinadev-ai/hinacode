export const mayHoldHtml = (markdown: string) => /<[a-z!/]/i.test(markdown)

let installed: Promise<void> | null = null

export const installHtmlParser = () =>
  (installed ??= import("../../../src/shared/document/htmlParser.ts").then(({ DocumentHtmlParser }) => {
    const host = globalThis as { window?: { DOMParser?: unknown }; DOMParser?: unknown }
    const window = (host.window ??= globalThis as { DOMParser?: unknown })
    window.DOMParser ??= DocumentHtmlParser
  }))
