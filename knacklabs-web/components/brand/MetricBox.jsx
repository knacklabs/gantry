import React from 'react';

export function MetricBox({ value, label, style }) {
  return (
    <div style={{
      background: 'rgba(28,107,73,.28)', border: '1px solid rgba(106,241,176,.22)',
      borderRadius: 8, padding: '10px 14px', fontFamily: 'var(--font-mono)',
      boxSizing: 'border-box', ...style,
    }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--kl-mint)', letterSpacing: '-0.01em', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#8FA89E', marginTop: 4 }}>{label}</div>
    </div>
  );
}
