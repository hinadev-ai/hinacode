Object.assign(window, {
  EXCALIDRAW_ASSET_PATH: new URL(`${import.meta.env.BASE_URL}excalidraw/`, window.location.href).href,
})
