import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import bashInit from "./shellIntegration/hinacode.bash?raw"
import fishHooks from "./shellIntegration/hinacode.fish?raw"
import zshHooks from "./shellIntegration/hinacode.zsh?raw"
import zshEnv from "./shellIntegration/zshenv.zsh?raw"

export interface Shell {
  readonly file: string
  readonly args: ReadonlyArray<string>
}

interface ShellLaunch extends Shell {
  readonly env: Readonly<Record<string, string>>
}

export const integratedLaunch = (dir: string, shell: Shell, env: NodeJS.ProcessEnv): ShellLaunch => {
  switch (basename(shell.file)) {
    case "zsh": {
      const userZdotdir = env["ZDOTDIR"]
      return {
        ...shell,
        env: { ZDOTDIR: dir, ...(userZdotdir === undefined ? {} : { HINACODE_USER_ZDOTDIR: userZdotdir }) },
      }
    }
    case "bash":
      return { file: shell.file, args: ["--init-file", join(dir, "hinacode.bash")], env: {} }
    case "fish":
      return {
        file: shell.file,
        args: [...shell.args, "--init-command", `source '${join(dir, "hinacode.fish")}'`],
        env: {},
      }
    default:
      return { ...shell, env: {} }
  }
}

export const makeShellIntegration = () => {
  const dir = mkdtempSync(join(tmpdir(), "hinacode-shell-"))
  writeFileSync(join(dir, ".zshenv"), zshEnv)
  writeFileSync(join(dir, "hinacode.zsh"), zshHooks)
  writeFileSync(join(dir, "hinacode.bash"), bashInit)
  writeFileSync(join(dir, "hinacode.fish"), fishHooks)
  return {
    launch: (shell: Shell, env: NodeJS.ProcessEnv) => integratedLaunch(dir, shell, env),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
