import { DEFAULT_THEMES } from "@pierre/diffs"
import { useWorkerPool, WorkerPoolContextProvider } from "@pierre/diffs/react"
// oxlint-disable-next-line import/default -- Vite builds the `?worker` import into a Worker constructor
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"
import { type ReactNode, useEffect } from "react"
import { useTheme } from "../lib/appearance.ts"
import { useClientSettings } from "../lib/settings.ts"

const poolOptions = { workerFactory: () => new DiffsWorker(), poolSize: 1 }

export function HighlightWorkerPool({ children }: { children: ReactNode }) {
  const theme = useTheme(useClientSettings().appearance.theme).codeTheme ?? DEFAULT_THEMES
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={{ theme, useTokenTransformer: true }}>
      <PoolTheme theme={theme} />
      {children}
    </WorkerPoolContextProvider>
  )
}

function PoolTheme({ theme }: { theme: string | typeof DEFAULT_THEMES }) {
  const pool = useWorkerPool()
  useEffect(() => {
    void pool?.setRenderOptions({ theme })
  }, [pool, theme])
  return null
}
