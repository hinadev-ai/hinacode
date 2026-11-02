import type { ImagePickerAsset } from "expo-image-picker"
import { expect, it, vi } from "vitest"

const staging = vi.hoisted(() => vi.fn(async () => ({ id: "staged" })))
const picker = vi.hoisted(() => vi.fn(async () => ({ canceled: true, assets: [] })))

vi.mock("react-native", () => ({ Platform: { OS: "web" } }))
vi.mock("expo-file-system", () => ({ File: class {} }))
vi.mock("expo-image-manipulator", () => ({ ImageManipulator: {}, SaveFormat: {} }))
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: picker }))
vi.mock("@/lib/connection", () => ({ call: staging }))

const { pickImages, stageImage } = await import("./stage-images")

it("stages a web image without native file-system methods", async () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const asset: ImagePickerAsset = {
    uri: `data:image/png;base64,${base64}`,
    width: 1,
    height: 1,
    base64,
    fileName: "logo.png",
  }

  await expect(stageImage("thread", asset)).resolves.toEqual({ attachment: { id: "staged" }, preview: asset.uri })
  expect(staging).toHaveBeenCalledWith("attachments.stage", {
    threadId: "thread",
    source: { dataUrl: asset.uri, name: "logo.png" },
  })
})

it("asks the web picker for the base64 bytes it can read", async () => {
  await pickImages()
  expect(picker).toHaveBeenCalledWith(expect.objectContaining({ base64: true, quality: 1 }))
})
