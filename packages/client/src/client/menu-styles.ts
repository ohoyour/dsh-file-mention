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
 * Injection: this module runs at bundle materialization, so the untagged
 * `<style>` element is claimed by the client module system (system.ts
 * `claimStyles`) and removed when the plugin unloads.
 */

export const MENU_ALIGN_CSS = `
[data-composer-card] [role="listbox"] {
  width: 100% !important;
  min-width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box;
}
`

if (typeof document !== 'undefined') {
  const tag = document.createElement('style')
  tag.textContent = MENU_ALIGN_CSS
  document.head.appendChild(tag)
}
