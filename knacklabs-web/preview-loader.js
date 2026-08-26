/* Preview-only loader: lets specimen cards and UI-kit pages render the
   component .jsx sources directly when the compiled _ds_bundle.js is not
   present yet. Requires React + Babel standalone on the page.
   NOT part of the design system API — consumers should use the bundle. */
window.KLPreview = async function (base, files) {
  const ns = (window.__KLPreviewNS = window.__KLPreviewNS || {});
  // Kick off all network requests up front so they overlap, then evaluate the
  // sources in list order (evaluation is order-dependent; the network is not).
  const sources = await Promise.all(files.map(function (f) {
    return fetch(base + f, { cache: 'no-cache' }).then(function (res) {
      return res.text().then(function (src) { return { res: res, src: src }; });
    }).catch(function () { return { res: { ok: false }, src: '' }; });
  }));
  for (let i = 0; i < files.length; i++) {
    const res = sources[i].res;
    let src = sources[i].src;
    // Skip files that no longer exist (404, or a plaintext "file not found"
    // body served with 200) so one stale list entry can't blank the page.
    if (!res.ok || /^\s*file not found\s*$/i.test(src)) continue;
    // strip ES module syntax; shared scope below replaces imports
    src = src.replace(/^\s*import[^\n]*$/gm, '').replace(/^\s*export\s+/gm, '');
    const code = Babel.transform(src, { presets: [['react', { runtime: 'classic' }]] }).code;
    const keys = Object.keys(ns);
    // Share every top-level function declaration across files, not just
    // capitalized components — some components import lowercase helpers from
    // siblings (e.g. fieldBoxStyle from Field.jsx). De-dupe the names.
    const fnNames = Array.from(new Set(Array.from(src.matchAll(/function\s+(\w+)/g)).map(function (m) { return m[1]; })));
    const body = code + '\n;return {' + fnNames.map(function (n) {
      return n + ': (typeof ' + n + ' !== "undefined" ? ' + n + ' : undefined)';
    }).join(',') + '};';
    const out = new Function('React', ...keys, body)(React, ...keys.map(function (k) { return ns[k]; }));
    for (const k in out) if (out[k]) ns[k] = out[k];
  }
  return ns;
};
/* Standard load order covering all inter-component dependencies. */
window.KL_ALL_COMPONENTS = [
  'components/core/Eyebrow.jsx',
  'components/core/Button.jsx',
  'components/core/Badge.jsx',
  'components/core/Card.jsx',
  'eventsData.jsx',
  'blogData.jsx',
  'components/brand/MetricBox.jsx',
  'components/brand/TerminalMockup.jsx',
  'components/brand/NumberedPoints.jsx',
  'components/brand/FlowSteps.jsx',
  'components/brand/EventAnnouncementBar.jsx',
  'components/isometric/IsoLabel.jsx',
  'components/isometric/IsoCanvas.jsx',
  'components/isometric/IsoConnector.jsx',
  'components/isometric/IsoDiamond.jsx',
  'components/isometric/IsoCloud.jsx',
  'components/isometric/IsoService.jsx',
  'components/isometric/IsoAgent.jsx',
  'components/isometric/IsoDatabase.jsx',
  'components/isometric/IsoWarehouse.jsx',
  'components/navigation/TopNav.jsx',
  'components/navigation/SiteHeader.jsx',
  'components/navigation/Footer.jsx',
  'components/forms/Field.jsx',
  'components/forms/TextField.jsx',
  'components/forms/Select.jsx',
  'components/forms/Checkbox.jsx',
  'Homepage.jsx',
  'ContactPage.jsx',
  'AiTransformationLeadPage.jsx',
  'CustomPlatformsPage.jsx',
  'AiAgentsPage.jsx',
  'ForwardDeployedTeamsPage.jsx',
  'EventsPage.jsx',
  'HomepageWithEventBar.jsx',
  'careersData.jsx',
  'CareersPage.jsx',
  'JobPage.jsx',
  'BlogPage.jsx',
  'BlogPostPage.jsx',
];
