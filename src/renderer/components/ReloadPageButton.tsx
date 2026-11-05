import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"

export function ReloadPageButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => location.reload()}>
      {m.web_reload()}
    </Button>
  )
}
