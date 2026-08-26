import React from 'react';

/* Dashed connector with small arrowheads + optional flowing data dot.
   Brand Book 08: "dashed lines with small arrowheads. No curved swooshes." */
export function IsoConnector({
  points = [[0, 0], [120, 60]],
  tone = 'emerald',
  arrow = true,
  endDots = true,
  animated = false,
  duration = 3,
  style,
}) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const pad = 8;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - minX + pad, h = Math.max(...ys) - minY + pad;
  const local = points.map((p) => [p[0] - minX, p[1] - minY]);
  const d = local.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
  const color = tone === 'slate' ? 'var(--kl-slate, #5F706A)' : 'var(--kl-emerald, #1C6B49)';
  // arrowhead at the end, oriented along the last segment
  const [ax, ay] = local[local.length - 1];
  const [px, py] = local[local.length - 2] || [ax - 10, ay];
  const ang = Math.atan2(ay - py, ax - px);
  const a1 = [ax - 7 * Math.cos(ang - 0.42), ay - 7 * Math.sin(ang - 0.42)];
  const a2 = [ax - 7 * Math.cos(ang + 0.42), ay - 7 * Math.sin(ang + 0.42)];
  return (
    <svg width={w} height={h} style={{ position: 'absolute', left: minX, top: minY, overflow: 'visible', pointerEvents: 'none', ...style }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.3" strokeDasharray="4 4" />
      {endDots ? <circle cx={local[0][0]} cy={local[0][1]} r="2.5" fill={color} /> : null}
      {arrow ? <path d={'M' + ax + ',' + ay + ' L' + a1[0] + ',' + a1[1] + ' L' + a2[0] + ',' + a2[1] + ' Z'} fill={color} /> : null}
      {animated ? (
        <circle r="3" fill="var(--kl-mint, #6AF1B0)" stroke={color} strokeWidth="1">
          <animateMotion dur={duration + 's'} repeatCount="indefinite" path={d} />
        </circle>
      ) : null}
    </svg>
  );
}
