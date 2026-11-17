export interface DesktopStreamProps {
  readonly url: string
  readonly onLoad: () => void
  readonly onFail: () => void
}
