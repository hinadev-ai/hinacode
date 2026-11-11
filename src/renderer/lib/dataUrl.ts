export const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => resolve(String(reader.result)))
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(file)
  })

export const blobFromDataUrl = (dataUrl: string) => {
  const comma = dataUrl.indexOf(",")
  const type = dataUrl.slice("data:".length, comma).replace(/;base64$/, "")
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), (character) => character.charCodeAt(0))
  return new Blob([bytes], { type })
}
