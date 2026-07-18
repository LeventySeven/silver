/**
 * ARIA role allowlists (plan Task 5).
 *
 * ADAPTED FROM reference/agent-browser/cli/src/native/snapshot.rs:11-62. Silver
 * stays a compatible superset of Vercel's INTERACTIVE grammar, but DELIBERATELY
 * NARROWS the CONTENT grammar: the plain-table roles `cell`/`columnheader`/
 * `rowheader` are dropped from CONTENT_ROLES per a Round-4 eval measurement (see
 * the inline rationale on the set below) — they are name-from-content roles that
 * flooded the interactive/action tree with non-actionable data cells. So a named
 * `<td>`/`<th>` grounds here ONLY when genuinely interactive, whereas Vercel's
 * grammar grounds every named cell. These sets drive ref-eligibility in the walk:
 *
 *   - INTERACTIVE_ROLES  -> always ref-eligible
 *   - CONTENT_ROLES      -> ref-eligible only when the node has a non-empty name
 *   - STRUCTURAL_ROLES   -> never ref-eligible on their own (but a cursor-
 *                           interactive structural node still becomes a ref)
 *
 * Role strings match what CDP `Accessibility.getFullAXTree` emits (Chrome uses
 * both ARIA role names and internal names like `Iframe`, `WebArea`,
 * `RootWebArea`, `StaticText`, `LabelText`).
 */

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
  'Iframe',
])

export const CONTENT_ROLES: ReadonlySet<string> = new Set([
  'heading',
  // MEASURED divergence from Vercel's verbatim grammar (eval harness, Round 4):
  // plain-table roles `cell`/`columnheader`/`rowheader` are name-FROM-CONTENT roles
  // (a `<td>`'s accessible name IS its text), so as CONTENT_ROLES they made EVERY
  // named data cell ref-eligible — a 10×4 table flooded the interactive/action tree
  // with 44 non-actionable `cell "…" [ref=eN]` lines (eval: data-table 297 obs-tokens,
  // only −41% vs full). A bare `<td>`/`<th>` is not an action target, so they are
  // removed here: a cell is ref-eligible ONLY when genuinely interactive (a
  // cursor-interactive cell, or an interactive child like a link/button, still
  // grounds via the formula's `cursorInteractive`/its own interactive role). The
  // FULL tree still renders them (they keep their SnapNode); only the interactive
  // tree sheds the noise. `gridcell` is KEPT — an ARIA `role=gridcell` signals an
  // interactive grid (spreadsheet) where cells are legitimate navigation targets.
  'gridcell',
  'listitem',
  'article',
  'region',
  'main',
  'navigation',
])

export const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
  'generic',
  'group',
  'list',
  'table',
  'row',
  'rowgroup',
  'grid',
  'treegrid',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'tree',
  'directory',
  'document',
  'application',
  'presentation',
  'none',
  'WebArea',
  'RootWebArea',
])
