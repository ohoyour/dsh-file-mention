/**
 * Menu/input width alignment stylesheet.
 *
 * The trigger candidate menu (`ui-input-trigger` MenuView) renders into the
 * `conversation.input.overlay` anchor — "exactly the card's width" per its
 * own CSS comment — but the menu surface itself clamps to
 * `min(260px, 100%)` / `max(min(537px, 100%))`, so on wide composer cards
 * the dropdown is narrower than the input box. This sheet forces the menu to
 * span the full anchor (= the input card) width, keeping it left-aligned
 * with the input text.
 *
 * Selector: `[data-composer-card] [role="listbox"]` — the menu is the only
 * listbox rendered inside the composer card, and the card attribute is a
 * stable product hook (the menu's own dismiss logic climbs it).
 *
 * Injection: the plugin installs this sheet during `apply` and removes the
 * exact owned element from its disposer. This keeps module evaluation pure
 * and avoids leaking a global style when the plugin is unloaded normally.
 */

export const MENU_ALIGN_CSS = `
[data-composer-card] [role="listbox"]:has([data-source="file"]) {
  width: 100% !important;
  min-width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box;
}
`

export function installMenuStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const tag = document.createElement('style')
  tag.setAttribute('data-file-mention-style', '')
  tag.textContent = MENU_ALIGN_CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
