import React from 'react';

/* The one site header used across every knacklabs.ai page. It now renders the
   shared <kl-site-header> web component (defined in siteChrome.js) so the header
   is byte-for-byte identical on the React pages AND the .dc.html case studies,
   and every nav link is managed in ONE place: the KLSite config in siteChrome.js.
   Add/rename/remove a link there and it updates everywhere. */

function ensureSiteChrome(assetBase) {
  if (typeof document === 'undefined') return;
  if (window.__KLSiteChromeLoaded || document.getElementById('kl-site-chrome-js')) return;
  const s = document.createElement('script');
  s.id = 'kl-site-chrome-js';
  s.src = (assetBase || './') + 'siteChrome.js';
  document.head.appendChild(s);
}

export function SiteHeader({ active = '', assetBase = './', base = '' }) {
  React.useEffect(() => ensureSiteChrome(assetBase), [assetBase]);
  return React.createElement('kl-site-header', { active, 'asset-base': base || assetBase || '' });
}
