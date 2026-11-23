import { findPaneOfType, leaves, normalize, placePane, setCollapsed, type LayoutNode, type Leaf } from '@lambda-house/workbench';

// The Documents view as a workbench layout (shared UI spec §5.3–5.4): the
// agent documents, the document groups, the contents. These pure functions
// keep Agent MCR's rules for it; the store holds the layout and saves it.

export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_WIDTH = 400;
export const TOC_MIN_WIDTH = 180;
export const TOC_MAX_WIDTH = 320;
export const PANEL_WIDTH = 280;
export const TOC_WIDTH = 220;

export type DocumentsPane = 'agent-docs' | 'contents';

/** The document groups' leaf. */
export const DOCUMENTS_LEAF = 'main';

const clamp = (n: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, n)));

/** The agent documents on the left, the groups, the contents; a memory window has no agent documents. */
export function defaultDocumentsLayout({ panelWidth = PANEL_WIDTH, filePanelVisible = true, tocWidth = TOC_WIDTH, tocVisible = true, withAgentDocs = true }: {
  panelWidth?: number; filePanelVisible?: boolean; tocWidth?: number; tocVisible?: boolean; withAgentDocs?: boolean;
} = {}): LayoutNode {
  const children: Leaf[] = [
    { kind: 'leaf', id: DOCUMENTS_LEAF, pane: { type: 'documents', key: 'main' } },
    { kind: 'leaf', id: 'right', pane: { type: 'contents', key: 'contents' }, collapsed: !tocVisible },
  ];
  const sizes = [{ fr: 1 }, { px: clamp(tocWidth, TOC_MIN_WIDTH, TOC_MAX_WIDTH) }];
  if (withAgentDocs) {
    children.unshift({ kind: 'leaf', id: 'left', pane: { type: 'agent-docs', key: 'agent-docs' }, collapsed: !filePanelVisible });
    sizes.unshift({ px: clamp(panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH) });
  }
  return { kind: 'split', id: 'documents', dir: 'row', children, sizes };
}

/** A layout Agent MCR can draw: one document groups pane, the others at most once, nothing it doesn't know. */
export function isDocumentsLayout(value: unknown): value is LayoutNode {
  try {
    const all = leaves(normalize(value as LayoutNode));
    const types = all.map((leaf) => leaf.pane?.type);
    const ids = all.map((leaf) => leaf.id);
    return types.filter((t) => t === 'documents').length === 1
      && new Set(ids).size === ids.length
      && types.every((t) => t === 'documents' || t === 'contents' || t === 'agent-docs')
      && new Set(types).size === types.length;
  } catch {
    return false;
  }
}

export const isPaneShown = (layout: LayoutNode, type: DocumentsPane): boolean => {
  const leaf = findPaneOfType(layout, type);
  return !!leaf && !leaf.collapsed;
};

/** Show a pane: one in the layout again, one its menu closed back on its side. */
export function showPane(layout: LayoutNode, type: DocumentsPane): LayoutNode {
  const leaf = findPaneOfType(layout, type);
  if (leaf) return setCollapsed(layout, leaf.id, false);
  const id = type === 'contents' ? 'right' : 'left';
  const pane: Leaf = { kind: 'leaf', id: leaves(layout).some((l) => l.id === id) ? `${type}-leaf` : id, pane: { type, key: type } };
  return type === 'contents'
    ? placePane(layout, DOCUMENTS_LEAF, 'after', pane, { px: TOC_WIDTH })
    : placePane(layout, DOCUMENTS_LEAF, 'before', pane, { px: PANEL_WIDTH });
}

export function hidePane(layout: LayoutNode, type: DocumentsPane): LayoutNode {
  const leaf = findPaneOfType(layout, type);
  return leaf && !leaf.collapsed ? setCollapsed(layout, leaf.id, true) : layout;
}

export const togglePane = (layout: LayoutNode, type: DocumentsPane): LayoutNode =>
  isPaneShown(layout, type) ? hidePane(layout, type) : showPane(layout, type);

/** What the app saved before the layout: widths and which panels showed. */
export function documentsLayoutFrom(saved: Record<string, unknown>, withAgentDocs = true): LayoutNode {
  return defaultDocumentsLayout({
    panelWidth: typeof saved.panelWidth === 'number' ? saved.panelWidth : undefined,
    filePanelVisible: saved.filePanelVisible !== false,
    tocWidth: typeof saved.tocWidth === 'number' ? saved.tocWidth : undefined,
    tocVisible: saved.tocVisible !== false,
    withAgentDocs,
  });
}
