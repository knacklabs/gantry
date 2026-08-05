export function Switch({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="relative inline-flex min-h-9 cursor-pointer items-center gap-2.5 text-[13px] font-semibold text-text">
      <span>{label}</span>
      <input
        checked={checked}
        className="peer absolute size-px opacity-0"
        onChange={(event) => onCheckedChange(event.target.checked)}
        type="checkbox"
      />
      <span
        aria-hidden="true"
        className="relative block h-5 w-9 rounded-full border border-border-strong bg-border-strong after:absolute after:top-0.5 after:left-0.5 after:size-3.5 after:rounded-full after:bg-surface after:shadow-control after:transition-transform after:duration-120 peer-checked:border-ink peer-checked:bg-ink peer-checked:after:translate-x-4 peer-focus-visible:outline-2 peer-focus-visible:outline-focus-ring peer-focus-visible:outline-offset-3"
      />
    </label>
  );
}
