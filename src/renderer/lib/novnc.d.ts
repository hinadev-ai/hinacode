// FIXME: @types/novnc__novnc types only "@novnc/novnc/lib/rfb", not the 1.7 "@novnc/novnc" entry
declare module "@novnc/novnc" {
  export interface RfbOptions {
    readonly shared?: boolean
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: string | object, options?: RfbOptions)
    viewOnly: boolean
    focusOnClick: boolean
    scaleViewport: boolean
    resizeSession: boolean
    background: string
    focus(options?: FocusOptions): void
    disconnect(): void
  }
}
