import { m } from "../../paraglide/messages.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"

const PLAIN = "plain"

export const CHART_LANGUAGE = "chart"

const LANGUAGES: ReadonlyArray<readonly [value: string, label: string]> = [
  ["bash", "Bash"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["html", "HTML"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["kotlin", "Kotlin"],
  ["markdown", "Markdown"],
  ["php", "PHP"],
  ["python", "Python"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["tsx", "TSX"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
]

const ALIASES: Readonly<Record<string, string>> = {
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
}

const languageOptions = (current: string) => {
  const canonical = ALIASES[current]
  const known = [
    { value: PLAIN, label: m.documents_code_plain() },
    ...LANGUAGES.map(([value, label]) => ({ value: value === canonical ? current : value, label })),
    { value: CHART_LANGUAGE, label: m.documents_code_chart() },
  ]
  return current === "" || known.some((option) => option.value === current)
    ? known
    : [...known, { value: current, label: current }]
}

export function CodeLanguagePicker({
  language,
  onChange,
}: {
  language: string
  onChange: (language: string | null) => void
}) {
  const options = languageOptions(language)
  return (
    <Select
      items={options}
      value={language === "" ? PLAIN : language}
      onValueChange={(next) => {
        if (next !== null) onChange(next === PLAIN ? null : next)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={m.documents_code_language()}
        className="h-6 border-transparent bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground dark:bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
