export function GantryMark({
  large,
  hero,
}: {
  large?: boolean;
  hero?: boolean;
}) {
  return (
    <span
      className={`gantry-mark ${large ? 'gantry-mark-large' : ''} ${hero ? 'gantry-mark-hero' : ''}`}
      aria-hidden="true"
    >
      {Array.from({ length: 9 }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}
