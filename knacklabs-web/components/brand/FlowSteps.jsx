import React from 'react';

/* Horizontal flow steps with mono numbers and → connectors (production deck). */
export function FlowSteps({ steps = [], onDark = false, style }) {
  const accent = onDark ? 'var(--kl-mint)' : 'var(--kl-emerald)';
  const [narrow, setNarrow] = React.useState(typeof window !== 'undefined' && window.innerWidth < 700);
  React.useEffect(() => {
    const onR = () => setNarrow(window.innerWidth < 700);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: narrow ? 22 : 0, flexWrap: 'wrap', fontFamily: 'var(--font-sans)', ...style }}>
      {steps.map((s, idx) => (
        <div key={idx} style={{ flex: 1, minWidth: 150, padding: narrow ? 0 : '0 18px', position: 'relative' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: accent, marginBottom: 8 }}>
            {s.num || ('0' + (idx + 1)).slice(-2)}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: onDark ? '#fff' : 'var(--kl-deep-forest)', marginBottom: 6 }}>{s.title}</div>
          <div style={{ fontSize: 14, lineHeight: 1.4, color: onDark ? 'var(--kl-text-on-dark)' : 'var(--kl-ink-2)' }}>{s.text}</div>
          {idx < steps.length - 1 && !narrow ? (
            <span style={{ position: 'absolute', right: -8, top: 30, color: accent, fontSize: 20 }}></span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
