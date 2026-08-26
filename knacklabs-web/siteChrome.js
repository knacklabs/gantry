/* =============================================================================
   KnackLabs site chrome — ONE shared header + footer for the whole site.

   This is the single source of truth for the site navigation. To add, remove,
   or rename a link anywhere on the site, edit the KLSite config object below —
   the change flows to every page (the React .jsx pages AND the .dc.html case
   studies), because they all render <kl-site-header> / <kl-site-footer>.

   Usage:
     <script src="./siteChrome.js"></script>   (load once, in <head> or <helmet>)
     <kl-site-header></kl-site-header>          (active page: add active="Gantry")
     <kl-site-footer></kl-site-footer>

   The home-page look (logo + Deep Forest nav; tall footer with the big K mark,
   agent-mesh field, three link columns and the scrolling tagline) is used
   everywhere. Rendered inside Shadow DOM so it never collides with the React or
   Design-Component reconcilers on the host page. Brand literals are inlined so
   it renders identically with or without the brand token stylesheets; fonts
   (@font-face) are inherited from the host document.
   ========================================================================== */
(function () {
  if (window.__KLSiteChromeLoaded) return;
  window.__KLSiteChromeLoaded = true;

  /* ----------------------------------------------------------------------- *
   *  SINGLE SOURCE OF TRUTH — edit links here, they update across the site  *
   * ----------------------------------------------------------------------- */
  var KLSite = window.KLSite = window.KLSite || {
    home: 'index.html',
    logoFull: 'assets/logos/KL-Logo-Full-White.png',   // header
    logoShort: 'assets/logos/KL-Logo-Short-White.png', // footer K mark
    mesh: 'assets/backgrounds/mesh-dark.png',

    // Top-nav links (left of the CTA)
    nav: [
      { label: 'Gantry', href: 'gantry.html' },
      { label: 'Blog', href: 'blog.html' },
      { label: 'Events', href: 'events.html' }
    ],

    // The single header CTA
    cta: { label: 'Talk to us', href: 'contact.html' },

    // Footer
    footer: {
      note: 'AI transformation, delivered from inside your business.',
      columns: [
        { heading: 'Offerings', links: [
          { label: 'AI Transformation Lead', href: 'fde.html' },
          { label: 'AI Agents', href: 'agents.html' },
          { label: 'AI Automation Platforms', href: 'custom-platforms.html' }
        ] },
        { heading: 'Platform', links: [
          { label: 'Gantry', href: 'gantry.html' },
          { label: 'Ukti', href: '#' },
          { label: 'Mainline', href: '#' }
        ] },
        { heading: 'Company', links: [
          { label: 'About', href: '#' },
          { label: 'Blog', href: 'blog.html' },
          { label: 'Events', href: 'events.html' },
          { label: 'Careers', href: 'careers.html' },
          { label: 'Talk to us', href: 'contact.html' }
        ] }
      ],
      legal: '\u00A9 ' + new Date().getFullYear() + ' Chimps At Work Studios Pvt Ltd',
      domain: 'knacklabs.ai'
    }
  };

  var DF = '#0C3529', DF2 = '#0A2C22', MINT = '#6AF1B0', MUTED = '#7E978D';
  var SANS = '"Inter", -apple-system, "Segoe UI", sans-serif';
  var MONO = '"JetBrains Mono", ui-monospace, monospace';
  var CONTAINER = '1180px';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function base(el) { return el.getAttribute('asset-base') || ''; }

  var HEADER_CSS =
    ':host{display:block;position:sticky;top:0;z-index:100;}' +
    '*{box-sizing:border-box;}' +
    '.kl-hd{display:flex;align-items:center;gap:32px;height:68px;padding:0 32px;font-family:' + SANS + ';background:' + DF + ';border-bottom:1px solid transparent;transition:background .35s ease,border-color .35s ease,box-shadow .35s ease;}' +
    '.kl-hd.scrolled{background:rgba(12,53,41,.72);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5);border-bottom:1px solid rgba(106,241,176,.16);box-shadow:0 8px 28px rgba(10,44,34,.28);}' +
    '.kl-hd-logo{display:flex;align-items:center;flex-shrink:0;}' +
    '.kl-hd-logo img{height:34px;display:block;}' +
    '.kl-hd-right{flex:1;display:flex;gap:26px;justify-content:flex-end;align-items:center;}' +
    '.kl-hd-links{display:flex;gap:26px;align-items:center;}' +
    '.kl-hd-link{font-size:14.5px;font-weight:500;text-decoration:none;color:rgba(255,255,255,.78);transition:color .2s ease;}' +
    '.kl-hd-link:hover{color:#fff;}' +
    '.kl-hd-link.active{color:' + MINT + ';font-weight:600;}' +
    '.kl-hd-cta{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 16px;border-radius:10px;background:' + MINT + ';color:' + DF + ';font-family:' + MONO + ';font-weight:600;font-size:13px;letter-spacing:.01em;text-transform:uppercase;text-decoration:none;white-space:nowrap;transition:filter .2s ease,transform .15s ease;}' +
    '.kl-hd-cta:hover{filter:brightness(1.06);}' +
    '.kl-hd-cta:active{transform:scale(.98);}' +
    '@media(max-width:700px){.kl-hd{gap:16px;padding:0 20px;}.kl-hd-links{display:none;}.kl-hd-logo img{height:30px;}}';

  var FOOTER_CSS =
    ':host{display:block;}' +
    '*{box-sizing:border-box;}' +
    '.kl-ft{position:relative;overflow:hidden;font-family:' + SANS + ';background:linear-gradient(180deg,#0B3026 0%,' + DF2 + ' 42%);}' +
    '.kl-ft-mesh{position:absolute;inset:0;background-size:cover;background-position:center top;background-repeat:no-repeat;opacity:.85;pointer-events:none;}' +
    '.kl-ft-inner{position:relative;}' +
    '.kl-ft-top{display:flex;gap:64px;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;max-width:' + CONTAINER + ';margin:0 auto;padding:64px 32px 8px;}' +
    '.kl-ft-mark{height:168px;width:auto;display:block;flex:none;}' +
    '.kl-ft-cols{display:flex;gap:64px;flex-wrap:wrap;}' +
    '.kl-ft-col{display:flex;flex-direction:column;gap:11px;}' +
    '.kl-ft-head{font-family:' + MONO + ';font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:' + MINT + ';margin-bottom:5px;}' +
    '.kl-ft-link{font-size:14px;color:rgba(255,255,255,.74);text-decoration:none;transition:color .15s ease;}' +
    '.kl-ft-link:hover{color:' + MINT + ';}' +
    '.kl-mq{width:100%;overflow:hidden;margin:48px 0 8px;padding:8px 0;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);}' +
    '.kl-mq-track{display:flex;width:max-content;animation:kl-mq-scroll 70s linear infinite;will-change:transform;}' +
    '.kl-mq-half{display:flex;flex:none;}' +
    '.kl-mq-phrase{display:inline-flex;align-items:center;flex:none;white-space:nowrap;font-size:clamp(34px,6.2vw,92px);font-weight:600;letter-spacing:-0.02em;line-height:1;color:rgba(255,255,255,0.22);}' +
    '.kl-mq-letter{display:inline-block;transition:color .14s ease,transform .14s ease;cursor:default;}' +
    '.kl-mq-letter:hover{color:' + MINT + ';transform:translateY(-0.04em);}' +
    '.kl-mq-sep{color:' + MINT + ';opacity:.85;font-size:.34em;margin:0 .55em;transform:translateY(-0.15em);}' +
    '.kl-ft-legal{max-width:' + CONTAINER + ';margin:24px auto 0;padding:20px 32px 30px;border-top:1px solid rgba(106,241,176,.18);font-family:' + MONO + ';font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:' + MUTED + ';display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;}' +
    '@keyframes kl-mq-scroll{from{transform:translate3d(0,0,0);}to{transform:translate3d(-50%,0,0);}}' +
    '@media(prefers-reduced-motion:reduce){.kl-mq-track{animation:none;}}' +
    '@media(max-width:760px){.kl-ft-mark{height:96px;}.kl-ft-top{gap:36px;padding:48px 24px 8px;}.kl-ft-cols{gap:36px;}.kl-ft-legal{padding:20px 24px 28px;}}';

  /* ============================ HEADER ============================ */
  class Header extends HTMLElement {
    static get observedAttributes() { return ['active', 'asset-base']; }
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
      var self = this;
      this._onScroll = function () {
        var nav = self.shadowRoot && self.shadowRoot.querySelector('.kl-hd');
        if (!nav) return;
        if (window.scrollY > 8) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');
      };
      this._onScroll();
      window.addEventListener('scroll', this._onScroll, { passive: true });
    }
    disconnectedCallback() {
      if (this._onScroll) window.removeEventListener('scroll', this._onScroll);
    }
    attributeChangedCallback() {
      if (this.isConnected && this.shadowRoot) { this.render(); if (this._onScroll) this._onScroll(); }
    }
    render() {
      var b = base(this);
      var active = this.getAttribute('active') || '';
      var links = KLSite.nav.map(function (n) {
        var on = n.label === active ? ' active' : '';
        return '<a class="kl-hd-link' + on + '" href="' + esc(b + n.href) + '">' + esc(n.label) + '</a>';
      }).join('');
      this.shadowRoot.innerHTML =
        '<style>' + HEADER_CSS + '</style>' +
        '<nav class="kl-hd">' +
          '<a class="kl-hd-logo" href="' + esc(b + KLSite.home) + '"><img src="' + esc(b + KLSite.logoFull) + '" alt="KnackLabs"></a>' +
          '<div class="kl-hd-right">' +
            '<span class="kl-hd-links">' + links + '</span>' +
            '<a class="kl-hd-cta" href="' + esc(b + KLSite.cta.href) + '">' + esc(KLSite.cta.label) + '</a>' +
          '</div>' +
        '</nav>';
    }
  }
  try { customElements.define('kl-site-header', Header); } catch (e) {}

  /* ============================ FOOTER ============================ */
  function letters(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i] === ' ' ? '\u00A0' : esc(text[i]);
      out += '<span class="kl-mq-letter">' + ch + '</span>';
    }
    return out;
  }
  function phrase(note) {
    return '<span class="kl-mq-phrase"><span>' + letters(note) + '</span><span class="kl-mq-sep">\u25C6</span></span>';
  }
  function half(note, aria) {
    return '<span class="kl-mq-half"' + (aria ? ' aria-hidden="true"' : '') + '>' + phrase(note) + phrase(note) + phrase(note) + phrase(note) + '</span>';
  }

  class Footer extends HTMLElement {
    static get observedAttributes() { return ['asset-base']; }
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
    }
    attributeChangedCallback() { if (this.isConnected && this.shadowRoot) this.render(); }
    render() {
      var b = base(this);
      var f = KLSite.footer;
      var cols = f.columns.map(function (c) {
        var ls = c.links.map(function (l) {
          var href = (l.href && l.href !== '#') ? esc(b + l.href) : '#';
          return '<a class="kl-ft-link" href="' + href + '"' + (href === '#' ? ' onclick="return false"' : '') + '>' + esc(l.label) + '</a>';
        }).join('');
        return '<div class="kl-ft-col"><div class="kl-ft-head">' + esc(c.heading) + '</div>' + ls + '</div>';
      }).join('');

      this.shadowRoot.innerHTML =
        '<style>' + FOOTER_CSS + '</style>' +
        '<footer class="kl-ft">' +
          '<div class="kl-ft-mesh" style="background-image:url(' + esc(b + KLSite.mesh) + ')"></div>' +
          '<div class="kl-ft-inner">' +
            '<div class="kl-ft-top">' +
              '<img class="kl-ft-mark" src="' + esc(b + KLSite.logoShort) + '" alt="KnackLabs">' +
              '<div class="kl-ft-cols">' + cols + '</div>' +
            '</div>' +
            '<div class="kl-mq"><div class="kl-mq-track">' + half(f.note, false) + half(f.note, true) + '</div></div>' +
            '<div class="kl-ft-legal"><span>' + esc(f.legal) + '</span><span>' + esc(f.domain) + '</span></div>' +
          '</div>' +
        '</footer>';
    }
  }
  try { customElements.define('kl-site-footer', Footer); } catch (e) {}
})();
