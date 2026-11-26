declare module "@novnc/novnc" {
  export interface RfbOptions {
    readonly shared?: boolean
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: string | object, options?: RfbOptions)
    viewOnly: boolean
    focusOnClick: boolean
    scaleViewport: boolean
    clipViewport: boolean
    dragViewport: boolean
    resizeSession: boolean
    background: string
    sendKey(keysym: number, code: string | null, down?: boolean): void
    disconnect(): void
  }
}
