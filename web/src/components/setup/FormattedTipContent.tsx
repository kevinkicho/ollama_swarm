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

export function TipSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-[11px] text-ink-300 leading-snug">{children}</div>
    </div>
  );
}

export function TipParagraph({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-ink-300 leading-snug break-words">{children}</p>;
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
      <div className="space-y-1.5">
        {body ? <TipParagraph>{body}</TipParagraph> : null}
        {items && items.length > 0 ? <TipBulletItems items={items} noWrap={noWrapItems} /> : null}
        {rows?.map((row) => <TipKvRow key={row.label} field={row} />)}
        {children}
      </div>
      {footer ? <p className={STRUCTURED_TIP_FOOTER_CLASS}>{footer}</p> : null}
    </div>
  );
}

