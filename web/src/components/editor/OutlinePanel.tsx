/* OutlinePanel — DOM tree (Figma-style Layers) for the active iframe.
 *
 * Hovering a row highlights the element in the iframe; clicking selects
 * it (drives the inspector when in Edit mode). Outer chrome (panel
 * wrapper, tabs, collapse) is owned by LeftPanel.
 */

import { useEffect, useMemo, useState } from "react";
import s from "./outline.module.css";
import { buildOutline, type OutlineNode } from "../../lib/outline";

type Props = {
  doc: Document | null;
  onSelect: (selector: string) => void;
  onHover: (selector: string | null) => void;
  selectedSelector?: string;
};

export function OutlinePanel({ doc, onSelect, onHover, selectedSelector }: Props) {
  const [tick, setTick] = useState(0);
  const root = useMemo(() => (doc ? buildOutline(doc) : null), [doc, tick]);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({ body: true });

  useEffect(() => {
    if (!doc) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, [doc]);

  return (
    <div className={s.outlineBody}>
      {root ? (
        <NodeRow
          node={root}
          depth={0}
          openMap={openMap}
          setOpen={(key, v) => setOpenMap((p) => ({ ...p, [key]: v }))}
          onSelect={onSelect}
          onHover={onHover}
          selectedSelector={selectedSelector}
        />
      ) : (
        <div className={s.outlineEmpty}>Iframe not loaded.</div>
      )}
    </div>
  );
}

function NodeRow({
  node, depth, openMap, setOpen, onSelect, onHover, selectedSelector,
}: {
  node: OutlineNode;
  depth: number;
  openMap: Record<string, boolean>;
  setOpen: (key: string, v: boolean) => void;
  onSelect: (selector: string) => void;
  onHover: (selector: string | null) => void;
  selectedSelector?: string;
}) {
  const open = openMap[node.selector] ?? depth < 2;
  const hasKids = node.children.length > 0;
  const isSelected = selectedSelector === node.selector;
  return (
    <>
      <div
        className={`${s.row} ${isSelected ? s.rowSelected : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => onSelect(node.selector)}
        onMouseEnter={() => onHover(node.selector)}
        onMouseLeave={() => onHover(null)}
      >
        <button
          className={s.toggle}
          onClick={(e) => { e.stopPropagation(); setOpen(node.selector, !open); }}
          aria-expanded={open}
          style={{ visibility: hasKids ? "visible" : "hidden" }}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className={s.tagName}>{node.tag}</span>
        {node.className && <span className={s.cls}>{node.className}</span>}
        {node.role && <span className={s.role}>[{node.role}]</span>}
      </div>
      {open && hasKids && node.children.map((c) => (
        <NodeRow
          key={c.selector}
          node={c}
          depth={depth + 1}
          openMap={openMap}
          setOpen={setOpen}
          onSelect={onSelect}
          onHover={onHover}
          selectedSelector={selectedSelector}
        />
      ))}
    </>
  );
}
