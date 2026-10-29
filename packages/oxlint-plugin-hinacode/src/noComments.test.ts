import { noComments } from "./noComments.ts"
import { ruleTester } from "./ruleTester.ts"

ruleTester.run("no-comments", noComments, {
  valid: [
    `const answer = 42`,
    `// FIXME: Electron drops the first resize event\nresize()`,
    `/* FIXME: remove once Node ships fetch timeouts */`,
    `// oxlint-disable-next-line no-console\nconsole.log(1)`,
    `/* eslint-disable no-console */`,
    `// @ts-expect-error the fixture is malformed on purpose\nparse(1)`,
    `/// <reference types="vite/client" />`,
    `const lazy = /* @__PURE__ */ create()`,
    `import(/* @vite-ignore */ path)`,
    `// prettier-ignore\nconst grid = [1,0,0,1]`,
  ],
  invalid: [
    { code: `// add one\nconst two = 1 + 1`, errors: [{ messageId: "comment" }] },
    { code: `/** Returns the answer. */\nexport const answer = 42`, errors: 1 },
    { code: `const a = 1 /* inline */ + 2`, errors: 1 },
    { code: `// TODO: later\n// NOTE: why`, errors: 2 },
    { code: `// fixme: lowercase is not a marker`, errors: 1 },
  ],
})
