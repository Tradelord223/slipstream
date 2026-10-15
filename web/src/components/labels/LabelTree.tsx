import { useMemo, useRef, useState } from "react";
import { useDismiss } from "../../lib/hooks.ts";
import { useStore } from "../../store/createStore.ts";
import { buildTree, labelStore, toggleCollapsed, useLabels, useLabelsSupported, type LabelNode } from "../../store/labels.ts";
import { useList } from "../../store/list.ts";
import { useRoute, viewPath } from "../../store/route.ts";
import { ui } from "../../store/ui.ts";
import { Icon } from "../Icon.tsx";
import { Link } from "../Link.tsx";
import { LabelDot } from "./LabelChip.tsx";
import { openLabelDialog } from "./LabelDialogs.tsx";

/** The Labels section of the rail: nested by "/", coloured, with unread counts and a menu on each label. */
export function LabelTree() {
  const labels = useLabels();
  const supported = useLabelsSupported();
  const collapsed = useStore(labelStore, (s) => s.collapsed);
  const route = useRoute();
  const listView = useList((s) => s.view);
  const view = route.name === "mail" ? route.view : route.name === "thread" ? listView : null;
  const active = view?.kind === "label" ? view.name.toLowerCase() : null;
  const tree = useMemo(() => buildTree(labels), [labels]);

  if (tree.length === 0 && !supported) return null;
  return (
    <>
      <div className="nav-heading nav-heading-row">
        <span>Labels</span>
        {supported && (
          <button className="icon-btn label-add" aria-label="New label" title="New label" onClick={() => openLabelDialog({ kind: "create" })}>
            <Icon name="plus" size={15} />
          </button>
        )}
      </div>
      {tree.length === 0 ? (
        <p className="nav-empty">No labels yet. Press L on a conversation to make one.</p>
      ) : (
        <ul className="nav nav-labels" role="list">
          {tree.map((n) => (
            <LabelItem key={n.path} node={n} depth={0} active={active} collapsed={collapsed} manage={supported} />
          ))}
        </ul>
      )}
    </>
  );
}

function LabelItem({ node, depth, active, collapsed, manage }: { node: LabelNode; depth: number; active: string | null; collapsed: ReadonlySet<string>; manage: boolean }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  useDismiss(ref, menu, () => setMenu(false));
  const kids = node.children.length > 0;
  const open = !collapsed.has(node.path);
  const isActive = active === node.path.toLowerCase();
  const label = node.label;
  const pick = (fn: () => void) => () => {
    setMenu(false);
    fn();
  };

  return (
    <li ref={ref} className="label-li">
      <div
        className="nav-item label-item"
        data-active={isActive || undefined}
        style={{ paddingLeft: 4 + depth * 14 }}
        onContextMenu={(e) => {
          if (!label || !manage) return;
          e.preventDefault();
          setMenu(true);
        }}
      >
        {kids ? (
          <button className="label-twist" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${node.path}`} onClick={() => toggleCollapsed(node.path)}>
            <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
          </button>
        ) : (
          <span className="label-twist" aria-hidden="true" />
        )}
        {label ? (
          <Link to={viewPath({ kind: "label", name: node.path })} className="label-link" aria-current={isActive ? "page" : undefined} onClick={() => ui.set({ sheetOpen: false })}>
            <LabelDot color={label.color} />
            <span className="nav-label">{node.name}</span>
            {node.unread > 0 && <span className="nav-count num">{node.unread}</span>}
          </Link>
        ) : (
          <button className="label-link" onClick={() => toggleCollapsed(node.path)}>
            <LabelDot color={null} />
            <span className="nav-label">{node.name}</span>
            {node.unread > 0 && <span className="nav-count num">{node.unread}</span>}
          </button>
        )}
        {label && manage && (
          <button className="label-more" aria-label={`Options for ${node.path}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="more" size={15} />
          </button>
        )}
      </div>
      {menu && label && (
        <div className="menu label-menu" role="menu" aria-label={`Options for ${node.path}`}>
          <button className="menu-item" role="menuitem" autoFocus onClick={pick(() => openLabelDialog({ kind: "rename", label }))}>
            Rename…
          </button>
          <button className="menu-item" role="menuitem" onClick={pick(() => openLabelDialog({ kind: "color", label }))}>
            Color…
          </button>
          <button className="menu-item" role="menuitem" onClick={pick(() => openLabelDialog({ kind: "create", name: `${node.path}/` }))}>
            New sub-label…
          </button>
          <button className="menu-item" role="menuitem" onClick={pick(() => openLabelDialog({ kind: "rule", label: node.path }))}>
            Auto-label…
          </button>
          <div className="menu-sep" />
          <button className="menu-item label-del" role="menuitem" onClick={pick(() => openLabelDialog({ kind: "delete", label }))}>
            Delete…
          </button>
        </div>
      )}
      {kids && open && (
        <ul className="nav" role="list">
          {node.children.map((c) => (
            <LabelItem key={c.path} node={c} depth={depth + 1} active={active} collapsed={collapsed} manage={manage} />
          ))}
        </ul>
      )}
    </li>
  );
}
