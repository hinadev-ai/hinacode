import { noManualMemo } from "./noManualMemo.ts"
import { ruleTester } from "./ruleTester.ts"

ruleTester.run("no-manual-memo", noManualMemo, {
  valid: [
    `const total = sum(items)`,
    `import { useState } from "react"; const [a] = useState(0)`,
    `function useMemo(f) { return f() }; useMemo(() => 1)`,
    `import { useMemo } from "./local"; useMemo(() => 1, [])`,
  ],
  invalid: [
    { code: `import { useMemo } from "react"; const x = useMemo(() => a, [a])`, errors: [{ messageId: "manualMemo" }] },
    { code: `import { useCallback as cb } from "react"; const f = cb(() => {}, [])`, errors: 1 },
    { code: `import { memo } from "react"; export const A = memo(function A() { return null })`, errors: 1 },
    { code: `import * as React from "react"; const x = React.useMemo(() => 1, [])`, errors: 1 },
    { code: `import React from "react"; const B = React.memo(A)`, errors: 1 },
  ],
})
