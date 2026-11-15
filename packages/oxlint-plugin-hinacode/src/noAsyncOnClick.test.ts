import { noAsyncOnClick } from "./noAsyncOnClick.ts"
import { ruleTester } from "./ruleTester.ts"

const component = (body: string, jsx: string) => `
export function Panel() {
  ${body}
  return ${jsx}
}`

ruleTester.run("no-async-on-click", noAsyncOnClick, {
  valid: [
    component("", `<Button action={() => archive()} />`),
    component("", `<AlertDialogAction action={archive} />`),
    component("", `<button onClick={() => setOpen(true)} />`),
    component("", `<button onClick={() => startTransition(archive)} />`),
    component("", `<DropdownMenuItem onClick={() => void archive()} />`),
    component("const archive = async () => {}", `<ContextMenuItem onClick={archive} />`),
    component("", `<Menu.ContextMenuItem onClick={async () => archive()} />`),
    component("", `<button onKeyDown={() => void archive()} onSubmit={async () => {}} />`),
    component("const archive = () => {}", `<button onClick={archive} />`),
    component("const hide = () => { setOpen(false) }", `<button onClick={hide} />`),
    component("", `<button onClick={props.hide} />`),
    `export function Panel({ onHide }) { void prefetch(); return <button onClick={onHide} /> }`,
    `export function Panel(onHide) { void prefetch(); return <button onClick={onHide} /> }`,
    component("const archive = () => {}", `<button onClick={() => archive()} />`),
    component("", `<button onClick={() => { if (ready) void archive() }} />`),
  ],
  invalid: [
    { code: component("", `<button onClick={async () => archive()} />`), errors: [{ messageId: "asyncOnClick" }] },
    { code: component("", `<button onClick={async function () {}} />`), errors: 1 },
    { code: component("", `<Button onClick={() => void archive()} />`), errors: 1 },
    { code: component("", `<button onClick={() => { setOpen(false); void archive() }} />`), errors: 1 },
    { code: component("const archive = async () => {}", `<button onClick={archive} />`), errors: 1 },
    { code: component("async function archive() {}", `<button onClick={archive} />`), errors: 1 },
    { code: component("const archive = async function () {}", `<button onClick={() => archive(id)} />`), errors: 1 },
    { code: component("async function archive() {}", `<button onClick={() => { archive() }} />`), errors: 1 },
    { code: component("const hide = () => { void toggle() }", `<button onClick={hide} />`), errors: 1 },
    { code: component("function hide() { setOpen(false); void toggle() }", `<button onClick={hide} />`), errors: 1 },
    {
      code: component("async function archive() {}\nconst hide = () => { archive() }", `<button onClick={hide} />`),
      errors: 1,
    },
  ],
})
