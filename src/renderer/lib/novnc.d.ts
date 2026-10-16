// @types/novnc__novnc declares "@novnc/novnc/lib/rfb", not the "@novnc/novnc" entry that 1.7 exports, and only
// takes a WebSocket or RTCDataChannel. These are the parts of noVNC 1.7 hinacode uses.
declare module "@novnc/novnc" {
  export interface RfbOptions {
    readonly shared?: boolean
  }

  export default class RFB extends EventTarget {
    /** `channel` is a WebSocket URL or any object shaped like a WebSocket. */
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
