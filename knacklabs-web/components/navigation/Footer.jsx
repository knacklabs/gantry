/* The one site footer used across every knacklabs.ai page. It now renders the
   shared <kl-site-footer> web component (defined in siteChrome.js) so the footer
   is byte-for-byte identical on the React pages AND the .dc.html case studies,
   and every footer link is managed in ONE place: the KLSite config in
   siteChrome.js. Props are accepted for backwards-compatibility but the content
   comes from that single config. */

function ensureSiteChromeFooter(assetBase) {
  if (typeof document === 'undefined') return;
  if (window.__KLSiteChromeLoaded || document.getElementById('kl-site-chrome-js')) return;
  const s = document.createElement('script');
  s.id = 'kl-site-chrome-js';
  s.src = (assetBase || './') + 'siteChrome.js';
  document.head.appendChild(s);
}

function Footer({ assetBase = './', base = '' } = {}) {
  React.useEffect(() => ensureSiteChromeFooter(assetBase), [assetBase]);
  return React.createElement('kl-site-footer', { 'asset-base': base || assetBase || '' });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Footer };
if (typeof window !== 'undefined') window.Footer = Footer;
