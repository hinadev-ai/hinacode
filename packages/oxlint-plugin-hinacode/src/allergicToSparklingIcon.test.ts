import { allergicToSparklingIcon } from "./allergicToSparklingIcon.ts"
import { ruleTester } from "./ruleTester.ts"

ruleTester.run("allergic-to-sparkling-icon", allergicToSparklingIcon, {
  valid: [
    `import { RiBrainLine, RiGuideLine } from "react-icons/ri"`,
    `import * as icons from "react-icons/ri"`,
    `import { Sparkline } from "./Sparkline.tsx"`,
    `import { RiSparkling2Line } from "./icons.ts"`,
  ],
  invalid: [
    {
      code: `import { RiSparkling2Line } from "react-icons/ri"`,
      errors: [{ messageId: "sparkling", data: { name: "RiSparkling2Line" } }],
    },
    { code: `import { RiSparklingFill as Magic } from "react-icons/ri"`, errors: 1 },
    { code: `import { RiBrainLine, RiSparkling2Line, RiSparklingLine } from "react-icons/ri"`, errors: 2 },
    { code: `import { TbSparkles } from "react-icons/tb"`, errors: 1 },
    { code: `import { PiSparkle } from "react-icons/pi"`, errors: 1 },
    { code: `export { RiSparkling2Line } from "react-icons/ri"`, errors: 1 },
  ],
})
