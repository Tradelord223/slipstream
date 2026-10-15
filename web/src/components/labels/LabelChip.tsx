import { useLabelColors } from "../../store/labels.ts";

/** A label as a small tinted chip in its own colour; a label without one stays neutral. */
export function LabelChip({ name }: { name: string }) {
  const color = useLabelColors().get(name.toLowerCase());
  return (
    <span className={`chip ${color ? "chip-label" : ""}`} style={color ? ({ ["--lc" as string]: color } as React.CSSProperties) : undefined}>
      {name}
    </span>
  );
}

/** The colour dot beside a label name. */
export function LabelDot({ color, size = 8 }: { color: string | null | undefined; size?: number }) {
  return <span className={`lbl-dot ${color ? "" : "none"}`} style={color ? { background: color, width: size, height: size } : { width: size, height: size }} aria-hidden="true" />;
}
