export const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => resolve(String(reader.result)))
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(file)
  })

export const textOfDataUrl = (dataUrl: string) => {
  const comma = dataUrl.indexOf(",")
  const body = dataUrl.slice(comma + 1)
  if (!dataUrl.slice(0, comma).endsWith(";base64")) return decodeURIComponent(body)
  return new TextDecoder().decode(Uint8Array.from(atob(body), (character) => character.charCodeAt(0)))
}
