import React from 'react';

/* Positioning surface for isometric diagrams: a relative container on the
   light canvas. Children are absolutely positioned; IsoConnector overlays.
   Optional faint dashed frame (the Baseten-style page grid). */
export function IsoCanvas({ width = 900, height = 520, frame = false, background = 'transparent', style, children }) {
  return (
    <div style={{
      position: 'relative', width, height, background,
      border: frame ? '1px dashed rgba(12,53,41,.18)' : 'none',
      boxSizing: 'border-box', overflow: 'visible', fontFamily: 'var(--font-sans)',
      ...style,
    }}>
      {children}
    </div>
  );
}

/* Absolute-position helper: <IsoAt x={120} y={80}><IsoDatabase/></IsoAt> */
export function IsoAt({ x = 0, y = 0, z = 1, center = false, style, children }) {
  return (
    <div style={{
      position: 'absolute', left: x, top: y, zIndex: z,
      transform: center ? 'translate(-50%, -50%)' : 'none',
      ...style,
    }}>
      {children}
    </div>
  );
}
