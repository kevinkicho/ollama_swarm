export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wide text-ink-400 mb-1">{label}</div>
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
