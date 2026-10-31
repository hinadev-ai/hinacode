import { noPromiseStateInEffect } from "./noPromiseStateInEffect.ts"
import { ruleTester } from "./ruleTester.ts"

const hooks = `import { useEffect, useState } from "react";`

ruleTester.run("no-promise-state-in-effect", noPromiseStateInEffect, {
  valid: [
    `${hooks} function A() { const [x, setX] = useState(0); useEffect(() => subscribe((value) => setX(value)), []) }`,
    `${hooks} function A() { const [x, setX] = useState(0); const onClick = () => load().then(setX) }`,
    `${hooks} function A() { const [x, setX] = useState(0); useEffect(() => { load().then(() => toast("done")) }, []) }`,
    `import { useEffect } from "react"; function A() { const [x, setX] = useLocal(0); useEffect(() => { load().then(setX) }, []) }`,
  ],
  invalid: [
    {
      code: `${hooks} function A({ id }) { const [x, setX] = useState(null); useEffect(() => { load(id).then(setX) }, [id]) }`,
      errors: [{ messageId: "promiseState" }],
    },
    {
      code: `${hooks} function A() { const [x, setX] = useState(null); useEffect(() => { let live = true; load().then((v) => live && setX(v)); return () => { live = false } }, []) }`,
      errors: 1,
    },
    {
      code: `${hooks} function A() { const [x, setX] = useState(null); useEffect(() => { load().then(ok, (e) => setX(e)) }, []) }`,
      errors: 1,
    },
    {
      code: `import * as React from "react"; function A() { const [x, setX] = React.useState(null); React.useLayoutEffect(() => { const t = setTimeout(() => load().then(setX)); return () => clearTimeout(t) }, []) }`,
      errors: 1,
    },
  ],
})
