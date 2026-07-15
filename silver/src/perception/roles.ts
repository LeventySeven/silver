/**
 * ARIA role allowlists (plan Task 5).
 *
 * Copied VERBATIM from reference/agent-browser/cli/src/native/snapshot.rs:11-62
 * so `silver` stays a compatible superset of Vercel's grammar. These sets drive
 * ref-eligibility in the walk:
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
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
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
