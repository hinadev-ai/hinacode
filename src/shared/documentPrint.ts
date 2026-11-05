const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

const escapeText = (text: string) => text.replace(/[&<>"']/g, (character) => entities[character] ?? character)

const CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"

const PRINT_STYLE = `
@page { margin: 0; }
body { margin: 0; font-size: 11pt; line-height: 1.6; }
.document { max-width: 46rem; margin: 0 auto; padding: 18mm 16mm; box-decoration-break: clone; }
input[type="checkbox"] { accent-color: var(--primary); }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; break-after: avoid; }
h1 { font-size: 1.9em; margin-top: 0; }
h2 { font-size: 1.45em; }
h3 { font-size: 1.2em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 0.9em; }
ul, ol { padding-inline-start: 1.4em; }
li > p { margin: 0.2em 0; }
ul[data-type="taskList"] { list-style: none; padding-inline-start: 0; }
ul[data-type="taskList"] > li { display: flex; gap: 0.5em; align-items: baseline; }
ul[data-type="taskList"] > li > div { flex: 1; min-width: 0; }
a { color: var(--primary); }
blockquote { margin-inline: 0; padding-inline-start: 1em; border-inline-start: 3px solid var(--primary); color: var(--muted-foreground); }
hr { border: 0; border-top: 1px solid var(--border); margin: 1.6em 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
:not(pre) > code { padding: 0.1em 0.3em; border-radius: 4px; background: var(--muted); }
pre { padding: 0.8em 1em; border-radius: var(--radius); background: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
table { width: 100%; border-collapse: collapse; break-inside: avoid; }
th, td { padding: 0.4em 0.6em; border-bottom: 1px solid var(--border); text-align: start; vertical-align: top; }
th > p, td > p { margin: 0; }
img { max-width: 100%; }
.ProseMirror-separator, [data-print-hidden], pre[hidden] { display: none; }
[data-callout] { margin: 0 0 0.9em; padding: 0.7em 1em 0.8em; border-radius: 10px; background: color-mix(in oklab, var(--callout-tone) 8%, transparent); break-inside: avoid; }
[data-node-view-content] > div > :first-child { margin-top: 0; }
[data-node-view-content] > div > :last-child { margin-bottom: 0; }
[data-callout-label] { all: unset; display: flex; align-items: center; gap: 0.4em; margin-bottom: 0.3em; font-size: 0.8em; font-weight: 500; color: var(--callout-tone); }
[data-callout-label] svg { width: 1.15em; height: 1.15em; }
[data-diagram] { margin: 0 0 1.2em; padding: 1em; border-radius: 10px; background: var(--muted); break-inside: avoid; }
[data-diagram] pre, [data-diagram] [hidden] { display: none; }
[data-diagram] svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
[data-chart] { margin: 0 0 1.2em; border-radius: 10px; background: var(--muted); overflow: hidden; break-inside: avoid; }
[data-chart] > div:first-child { padding: 0.9em 1em; }
[data-chart] p { margin: 0; }
[data-chart] pre, [data-chart] [hidden] { display: none; }
[data-chart-title] { font-weight: 600; text-wrap: balance; }
[data-chart-notes] { margin-top: 0.2em; font-size: 0.85em; white-space: pre-line; color: var(--muted-foreground); }
[data-chart] ul { display: flex; flex-wrap: wrap; gap: 0.3em 1.2em; margin: 0.6em 0; padding: 0; list-style: none; font-size: 0.8em; color: var(--muted-foreground); }
[data-chart] li { display: flex; align-items: center; gap: 0.4em; }
[data-chart] li > span { width: 0.65em; height: 0.65em; border-radius: 2px; }
[data-chart] svg { display: block; max-width: 100%; height: auto; }
`

export const documentPrintHtml = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><title>${escapeText(title)}</title><style>${PRINT_STYLE}</style></head><body><main class="document">${body}</main></body></html>`
