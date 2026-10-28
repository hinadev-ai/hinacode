const { app } = require("electron")

globalThis.hinacodeStartupAppearance = new Promise((done, fail) => {
  app.once("browser-window-created", (_, nativeWindow) => {
    if (nativeWindow.isVisible()) {
      fail(new Error("The window was visible when it was created"))
      return
    }
    nativeWindow.once("show", () => {
      nativeWindow.webContents
        .executeJavaScript(
          `(() => {
            const snapshot = () => ({
              scheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
              rendered: (document.getElementById("root")?.childElementCount ?? 0) > 0,
              // On macOS the body is clear so the glass shows through; <main> paints the theme background.
              background: getComputedStyle(document.querySelector("main") ?? document.body).backgroundColor
            })
            const firstVisible = snapshot()
            return new Promise(done => {
              const observer = new PerformanceObserver(list => {
                if (list.getEntries().some(entry => entry.name === "first-contentful-paint")) {
                  observer.disconnect()
                  done({ firstVisible, firstPaint: snapshot() })
                }
              })
              observer.observe({ type: "paint", buffered: true })
            })
          })()`,
        )
        .then(done, fail)
    })
  })
})
