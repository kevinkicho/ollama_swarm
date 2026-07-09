import { type ReactNode } from "react";

export const STRUCTURED_TIP_FOOTER_CLASS =
  "text-[10px] text-ink-500 opacity-50 pt-0.5 border-t border-ink-700/40";

export const TIP_HEADER_CLASS =
  "text-ink-200 font-medium text-[11px] border-b border-ink-700/60 pb-1.5";

export type TipKvField = {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
  accent?: string;
};

export function TipKvRow({ field }: { field: TipKvField }) {
  if (field.multiline) {
    return (
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[9px] uppercase tracking-wide text-ink-500">{field.label}</span>
        <span className="text-[11px] text-ink-300 break-words leading-snug">{field.value}</span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0">
      <span className="text-[9px] uppercase tracking-wide text-ink-500 shrink-0">{field.label}</span>
      <span
        className={`text-[11px] text-right truncate min-w-0 ${field.mono ? "font-mono" : ""} ${
          field.accent ?? "text-ink-200"
        }`}
      >
        {field.value}
      </span>
    </div>
  );
}

export function TipBulletItems({
  items,
  noWrap = false,
}: {
  items: readonly string[];
  noWrap?: boolean;
}) {
  return (
    <ul className={`space-y-1 ${noWrap ? "" : ""}`}>
      {items.map((item) => (
        <li
          key={item}
          className={`flex gap-2 text-[11px] text-ink-300 leading-snug ${noWrap ? "whitespace-nowrap" : ""}`}
        >
          <span className="text-violet-400/80 shrink-0">•</span>
          <span className={noWrap ? "whitespace-nowrap" : "break-words"}>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export const TIP_DIVIDER_CLASS = "border-t border-ink-700/50";

export function TipDivider() {
  return <div className={TIP_DIVIDER_CLASS} role="separator" />;
}

export function TipPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded border border-ink-700/50 bg-ink-950/35 px-2 py-1.5 min-w-0 ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

export type TipSectionAccent = "default" | "emerald" | "violet";

export function TipSection({
  label,
  children,
  divider = false,
  accent = "default",
}: {
  label: string;
  children: ReactNode;
  /** Draw a divider above this section (not shown for the first block). */
  divider?: boolean;
  /** Left border accent on the section label. */
  accent?: TipSectionAccent;
}) {
  const labelAccent =
    accent === "emerald"
      ? "border-l-2 border-emerald-500/55 pl-1.5"
      : accent === "violet"
        ? "border-l-2 border-violet-500/55 pl-1.5"
        : "";
  return (
    <>
      {divider ? <TipDivider /> : null}
      <div className="space-y-1 min-w-0">
        <div className={`text-[9px] uppercase tracking-wide text-ink-500 ${labelAccent}`}>
          {label}
        </div>
        <div className="text-[11px] text-ink-300 leading-snug min-w-0">{children}</div>
      </div>
    </>
  );
}

export function TipParagraph({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-ink-300 leading-snug break-words">{children}</p>;
}

export type TipTableRow = {
  cells: readonly string[];
  /** Accent class applied to the last cell (e.g. current config highlight). */
  accent?: string;
  /** Subtle row background for the active / current setting. */
  highlight?: boolean;
};

type TipColAlign = "left" | "right" | "center";

function cellAlignClass(align: TipColAlign | undefined, j: number, cols: number): string {
  const a =
    align ??
    (j === 0 ? "left" : j === cols - 1 && cols > 2 ? "right" : "left");
  if (a === "right") return "text-right";
  if (a === "center") return "text-center";
  return "text-left";
}

/** Compact 2–3 column table for structured tooltips (presets, specs, drafts). */
export function TipCompactTable({
  headers,
  rows,
  mono = true,
  hideHeader = false,
  bordered = false,
  variant = "default",
  colAlign,
  colWidths,
}: {
  headers: readonly string[];
  rows: readonly TipTableRow[];
  mono?: boolean;
  /** Use for label/value tables with no column titles. */
  hideHeader?: boolean;
  /** Outer border + row dividers. */
  bordered?: boolean;
  /** Two-column label/value layout with fixed label column. */
  variant?: "default" | "kv";
  colAlign?: readonly TipColAlign[];
  /** Tailwind width classes per column (e.g. w-10, w-[38%]). */
  colWidths?: readonly string[];
}) {
  const isKv = variant === "kv";
  const colCount = rows[0]?.cells.length ?? headers.length;
  const resolvedAlign: TipColAlign[] = isKv
    ? ["left", "right"]
    : colAlign
      ? [...colAlign]
      : colCount === 3
        ? ["center", "left", "right"]
        : ["left", "right"];

  const tableShell = bordered
    ? "rounded border border-ink-700/50 overflow-hidden bg-ink-950/25"
    : "";

  return (
    <div className={tableShell}>
      <table className="w-full text-[10px] border-collapse table-fixed">
        {hideHeader || isKv ? null : (
          <thead>
            <tr
              className={`text-[9px] uppercase tracking-wide text-ink-500 ${
                bordered ? "border-b border-ink-700/50 bg-ink-900/50" : ""
              }`}
            >
              {headers.map((h, j) => (
                <th
                  key={h || j}
                  className={`font-normal px-2 py-1 ${cellAlignClass(resolvedAlign[j], j, colCount)} ${
                    colWidths?.[j] ?? ""
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody className={mono ? "font-mono" : ""}>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={`text-ink-300 leading-tight ${
                bordered && i < rows.length - 1 ? "border-b border-ink-700/35" : ""
              } ${row.highlight ? "bg-emerald-950/25" : ""}`}
            >
              {row.cells.map((cell, j) => (
                <td
                  key={j}
                  className={`px-2 py-1 align-middle ${cellAlignClass(resolvedAlign[j], j, colCount)} ${
                    colWidths?.[j] ?? ""
                  } ${
                    isKv && j === 0
                      ? "text-[9px] uppercase tracking-wide text-ink-500 font-sans"
                      : ""
                  } ${
                    row.accent && j === row.cells.length - 1 ? row.accent : ""
                  } ${isKv && j === 1 ? "tabular-nums" : ""}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Monospace flow diagram for tooltip figures. */
export function TipFigure({
  lines,
  panel = true,
  centered = true,
}: {
  lines: readonly string[];
  panel?: boolean;
  centered?: boolean;
}) {
  const pre = (
    <pre
      className={`text-[10px] font-mono text-ink-300 leading-tight whitespace-pre overflow-x-auto m-0 ${
        centered ? "text-center" : ""
      }`}
    >
      {lines.join("\n")}
    </pre>
  );
  return panel ? <TipPanel className={centered ? "text-center" : ""}>{pre}</TipPanel> : pre;
}

export function FormattedTipContent({
  title,
  body,
  items,
  rows,
  footer,
  noWrapItems = false,
  children,
}: {
  title?: ReactNode;
  body?: ReactNode;
  items?: readonly string[];
  rows?: readonly TipKvField[];
  footer?: ReactNode;
  noWrapItems?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2 min-w-[200px]">
      {title ? <div className={TIP_HEADER_CLASS}>{title}</div> : null}
      <div className="space-y-2">
        {body ? <TipParagraph>{body}</TipParagraph> : null}
        {items && items.length > 0 ? <TipBulletItems items={items} noWrap={noWrapItems} /> : null}
        {rows?.map((row) => <TipKvRow key={row.label} field={row} />)}
        {children}
      </div>
      {footer ? <p className={STRUCTURED_TIP_FOOTER_CLASS}>{footer}</p> : null}
    </div>
  );
}

