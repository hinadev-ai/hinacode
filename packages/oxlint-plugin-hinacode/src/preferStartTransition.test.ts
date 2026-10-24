import { preferStartTransition } from "./preferStartTransition.ts"
import { ruleTester } from "./ruleTester.ts"

const component = (body: string, jsx: string) => `
import { startTransition, useActionState, useReducer, useState, useTransition } from "react"
export function Panel() {
  const [open, setOpen] = useState(false)
  ${body}
  return ${jsx}
}`

ruleTester.run("prefer-start-transition", preferStartTransition, {
  valid: [
    component("", `<button onClick={() => startTransition(() => setOpen(true))} />`),
    component(
      "const [pending, startOpening] = useTransition()",
      `<button onClick={() => startOpening(() => setOpen(true))} />`,
    ),
    component("", `<Button action={() => setOpen(true)} />`),
    component("", `<Tabs changeAction={() => setOpen(true)} />`),
    component(
      "const [query, setQuery] = useState('')",
      `<input value={query} onChange={(event) => setQuery(event.target.value)} />`,
    ),
    component("", `<div onPointerMove={() => setOpen(true)} onKeyDown={() => setOpen(false)} />`),
    component("", `<Popover onOpenChange={setOpen} onOpenChangeComplete={() => setOpen(false)} />`),
    component("", `<Checkbox onCheckedChange={setOpen} />`),
    component("", `<div onContextMenu={() => setOpen(true)} onLostPointerCapture={() => setOpen(false)} />`),
    component("", `<button onClick={() => useDrafts.getState().setText("x")} />`),
    component("useEffect(() => setOpen(false), [])", `<div />`),
    component("const close = () => setOpen(false)", `<div ref={close} />`),
  ],
  invalid: [
    {
      code: component("", `<button onClick={() => setOpen(true)} />`),
      errors: [{ messageId: "outsideTransition", data: { setter: "setOpen", handler: "onClick" } }],
    },
    { code: component("", `<Form onSave={setOpen} />`), errors: 1 },
    { code: component("const toggle = () => setOpen((value) => !value)", `<button onClick={toggle} />`), errors: 1 },
    { code: component("function close() { setOpen(false) }", `<button onClick={close} />`), errors: 1 },
    {
      code: component("const [count, dispatch] = useReducer(reduce, 0)", `<button onClick={() => dispatch(1)} />`),
      errors: 1,
    },
    { code: component("const [error, run] = useActionState(save, null)", `<button onClick={run} />`), errors: 1 },
    {
      code: component("", `<button onClick={() => void copy().then(() => setOpen(true))} />`),
      errors: 1,
    },
  ],
})
