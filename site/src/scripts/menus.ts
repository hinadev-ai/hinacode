const menus = [...document.querySelectorAll<HTMLDetailsElement>("details[data-menu]")]

document.addEventListener("click", (event) => {
  for (const menu of menus) if (menu.open && !menu.contains(event.target as Node)) menu.open = false
})

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return
  for (const menu of menus) {
    if (!menu.open) continue
    menu.open = false
    menu.querySelector("summary")?.focus()
  }
})
