export function ResultReceipt({
  attention,
  changed,
  completed,
  delegated,
  used,
}: {
  attention: string;
  changed: string;
  completed: string;
  delegated: boolean;
  used: string;
}) {
  return (
    <dl className="m-0 grid gap-2 text-xs">
      <ReceiptRow label="Completed" value={completed} />
      <ReceiptRow label="Used" value={used} />
      <ReceiptRow label="Changed" value={changed} />
      <ReceiptRow label="Delegated" value={delegated ? 'yes' : 'no'} />
      <ReceiptRow label="Needs attention" value={attention} />
    </dl>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
      <dt className="font-semibold text-text">{label}:</dt>
      <dd className="m-0 text-text-secondary">{value}</dd>
    </div>
  );
}
