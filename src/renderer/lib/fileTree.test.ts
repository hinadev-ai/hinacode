import { expect, test } from "vitest"
import { fileTree } from "./fileTree.ts"

const file = (path: string) => ({ path })

test("nests files under their folders and joins a folder chain that holds nothing else", () => {
  const tree = fileTree([file(".github/workflows/ci.yml"), file(".github/workflows/deploy.yml"), file("README.md")])
  expect(tree).toStrictEqual({
    name: "",
    path: "",
    folders: [
      {
        name: ".github/workflows",
        path: ".github/workflows/",
        folders: [],
        files: [file(".github/workflows/ci.yml"), file(".github/workflows/deploy.yml")],
      },
    ],
    files: [file("README.md")],
  })
})

test("keeps a folder that holds files of its own apart from its subfolders", () => {
  const tree = fileTree([file("src/main/a.ts"), file("src/b.ts")])
  expect(tree.folders).toStrictEqual([
    {
      name: "src",
      path: "src/",
      folders: [{ name: "main", path: "src/main/", folders: [], files: [file("src/main/a.ts")] }],
      files: [file("src/b.ts")],
    },
  ])
})
