export function Field({
  label,
  hint,
  labelAccessory,
  children,
}: {
  label: string;
  hint?: string;
  /** Optional element rendered on the right side of the label row.
   *  Used by the User directive field to host the per-preset
   *  DirectiveBadge ("✓ honored by this preset" / "✕ ignored …")
   *  next to the field's label, where it speaks directly to the
   *  affordance it modifies. */
  labelAccessory?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wide text-ink-400 mb-1 flex items-center justify-between gap-3">
        <span>{label}</span>
        {labelAccessory}
      </div>
      {children}
      {hint ? <div className="text-xs text-ink-400 mt-1">{hint}</div> : null}
    </label>
  );
}

// Boolean checkbox styled to fit the same Field rhythm. Used for the
// blackboard topology toggles (Units 58 / 59 / 60). The label wraps
// the input so clicking the title toggles too.
export function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="block cursor-pointer">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-emerald-500"
        />
        <span className="text-xs uppercase tracking-wide text-ink-400">{label}</span>
      </div>
      {hint ? <div className="text-xs text-ink-400 mt-1">{hint}</div> : null}
    </label>
  );
}
