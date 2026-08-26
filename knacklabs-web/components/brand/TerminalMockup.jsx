import React from 'react';
import { MetricBox } from './MetricBox.jsx';

/* The brand's signature proof artifact (Brand Book 08, System 1):
   shows the ACTUAL deployed system. Required on every case study. */
export function TerminalMockup({
  url = 'app.client.com/ops',
  status = 'live',
  bars = [72, 48, 88, 56],
  metrics = [],
  children,
  style,
}) {
  return (
    <div style={{
      background: 'var(--kl-deep-forest, #0C3529)',
      border: '1px solid rgba(106,241,176,.18)',
      borderRadius: 'var(--radius-lg, 14px)', overflow: 'hidden',
      boxShadow: 'var(--shadow-float)', fontFamily: 'var(--font-mono)',
      boxSizing: 'border-box', ...style,
    }}>
      {/* top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
        borderBottom: '1px solid rgba(106,241,176,.14)',
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(28,107,73,.65)' }}></span>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(28,107,73,.65)' }}></span>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(28,107,73,.65)' }}></span>
        </div>
        <div style={{ flex: 1, fontSize: 12, color: '#8FA89E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</div>
        <span style={{
          fontSize: 10, fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase',
          color: 'var(--kl-mint)', background: 'rgba(106,241,176,.14)',
          border: '1px solid rgba(106,241,176,.3)', borderRadius: 999, padding: '2px 10px',
        }}>{status}</span>
      </div>
      {/* body */}
      <div style={{ padding: '16px 16px 18px' }}>
        {bars && bars.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: metrics.length || children ? 16 : 0 }}>
            {bars.map((w, idx) => (
              <div key={idx} style={{ height: 8, borderRadius: 4, background: 'rgba(106,241,176,.12)' }}>
                <div style={{ width: Math.max(4, Math.min(100, w)) + '%', height: '100%', borderRadius: 4, background: 'var(--kl-mint)', opacity: .85 }}></div>
              </div>
            ))}
          </div>
        ) : null}
        {metrics.length ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(' + Math.min(metrics.length, 3) + ', 1fr)', gap: 10 }}>
            {metrics.map((m, idx) => <MetricBox key={idx} value={m.value} label={m.label} />)}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
