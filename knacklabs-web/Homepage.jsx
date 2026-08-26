import React from 'react';
import { Button } from 'components/core/Button.jsx';
import { Eyebrow } from 'components/core/Eyebrow.jsx';
import { Card } from 'components/core/Card.jsx';
import { TopNav } from 'components/navigation/TopNav.jsx';
import { SiteHeader } from 'components/navigation/SiteHeader.jsx';
import { Footer } from 'components/navigation/Footer.jsx';
import { TerminalMockup } from 'components/brand/TerminalMockup.jsx';
import { FlowSteps } from 'components/brand/FlowSteps.jsx';
import { NumberedPoints } from 'components/brand/NumberedPoints.jsx';
import { IsoAt } from 'components/isometric/IsoCanvas.jsx';
import { IsoAgent } from 'components/isometric/IsoAgent.jsx';

/* knacklabs.ai homepage, structure from Brand Book 11 (hero → three paths →
   three pillars with proof → proof strip → closing CTA), copy rules from 12.
   Mobile-first per Brand Book 11: stacks to one column below 760px. */
function useNarrow(bp = 760) {
  const [n, setN] = React.useState(typeof window !== 'undefined' && window.innerWidth < bp);
  React.useEffect(() => {
    const onR = () => setN(window.innerWidth < bp);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, [bp]);
  return n;
}

/* Scroll-triggered reveal, fades + lifts content in the first time it enters
   the viewport, then leaves it alone. Uses a scroll/resize check (reliable
   across embeds) with a timeout safety net so content never stays hidden.
   Honors prefers-reduced-motion. */
function Reveal({ children, delay = 0, y = 26, style, as = 'div' }) {
  const ref = React.useRef(null);
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(true); return; }
    let done = false;
    const reveal = () => { if (done) return; done = true; cleanup(); setShown(true); };
    const check = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.top < vh * 0.9 && r.bottom > 0) reveal();
    };
    const onScroll = () => check();
    function cleanup() {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      clearTimeout(safety);
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    // initial check (covers above-the-fold content) + safety net
    const raf = requestAnimationFrame(check);
    const safety = setTimeout(reveal, 1600);
    return () => { cancelAnimationFrame(raf); cleanup(); };
  }, []);
  return React.createElement(as, {
    ref,
    style: {
      opacity: shown ? 1 : 0,
      transform: shown ? 'none' : 'translateY(' + y + 'px)',
      transition: 'opacity .7s cubic-bezier(.2,.7,.2,1) ' + delay + 's, transform .7s cubic-bezier(.2,.7,.2,1) ' + delay + 's',
      willChange: 'opacity, transform',
      ...style,
    },
  }, children);
}

export function Homepage({ assetBase = './' }) {
  const narrow = useNarrow();
  const [heroIn, setHeroIn] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setHeroIn(true), 60);
    return () => clearTimeout(t);
  }, []);
  const rise = (delay) => ({
    opacity: 1,
    transform: heroIn ? 'none' : 'translateY(14px)',
    transition: 'transform .8s cubic-bezier(.2,.7,.2,1) ' + delay + 's',
  });
  const wrap = { maxWidth: 'var(--container-max, 1180px)', margin: '0 auto', padding: '0 clamp(20px, 4.5vw, 32px)', boxSizing: 'border-box' };
  const h2 = { fontSize: 'clamp(22px, 4vw, 26px)', fontWeight: 600, color: 'var(--kl-deep-forest)', margin: 0, letterSpacing: '-0.01em' };

  return (
    <div style={{ fontFamily: 'var(--font-sans)', background: 'var(--kl-off-white)', color: 'var(--kl-ink)' }}>
      <SiteHeader assetBase={assetBase} />

      {/* ===== Hero, dark brand moment, live agent-orchestration mesh ===== */}
      <section style={{
        background: 'var(--gradient-hero)',
        minHeight: 'clamp(560px, 80vh, 800px)',
        display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden',
      }}>
        <style>{'@media (prefers-reduced-motion: reduce){.kl-hero *{transition:none!important}.kl-marquee-track{animation:none!important}}@keyframes klMarquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}'}</style>
        <HeroAgentMesh />
        <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
          background: 'linear-gradient(102deg, rgba(10,44,34,.94) 0%, rgba(10,44,34,.72) 26%, rgba(10,44,34,.26) 50%, rgba(10,44,34,0) 70%), linear-gradient(to top, rgba(8,38,29,.8) 0%, rgba(8,38,29,0) 30%), radial-gradient(120% 120% at 50% 50%, rgba(0,0,0,0) 58%, rgba(6,30,23,.5) 100%)' }} />
        <div className="kl-hero" style={{ ...wrap, position: 'relative', zIndex: 2, width: '100%', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingTop: 'clamp(40px, 7vw, 72px)', paddingBottom: 'clamp(28px, 4vw, 48px)' }}>
          <Eyebrow onDark size="lg" style={{ marginBottom: 18, fontSize: 'clamp(12px, 2vw, 15px)', ...rise(0.08) }}>AI Transformation Company</Eyebrow>
          <h1 style={{
            fontSize: 'clamp(34px, 6.5vw, 60px)', fontWeight: 800, lineHeight: 1.06,
            letterSpacing: '-0.032em', color: '#fff', margin: 0, maxWidth: '15ch',
            ...rise(0.15),
          }}>
            We don&rsquo;t advise on AI. <span style={{ color: 'var(--kl-mint)' }}>We ship it.</span>
          </h1>
          <p style={{ fontSize: 'clamp(14px, 1.9vw, 16.5px)', lineHeight: 1.55, color: 'var(--kl-text-on-dark)', maxWidth: '46ch', margin: '18px 0 0', ...rise(0.3) }}>
            AI agents and automation platforms that run your operations.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', ...rise(0.45) }}>
            <Button variant="dark-primary" mono>Talk to us</Button>
            <Button variant="dark-ghost" mono>See how we build</Button>
          </div>
        </div>
        <HeroLogoMarquee rise={rise} wrap={wrap} assetBase={assetBase} />
      </section>

      {/* ===== Gantry, flagship product feature band, directly below the hero ===== */}
      <GantryPlatformBand narrow={narrow} wrap={wrap} assetBase={assetBase} href="gantry.html" />

      {/* ===== FDE / AI Transformation Lead, dark CTA band ===== */}
      <FdeLeadBand narrow={narrow} wrap={wrap} assetBase={assetBase} href="fde.html" />

      {/* ===== SaaS is dead, build custom platforms instead ===== */}
      <SaasIsDeadBand narrow={narrow} wrap={wrap} />

      {/* ===== Three offerings ===== */}
      <section style={{ padding: '64px 0 56px' }}>
        <div style={wrap}>
          <Reveal>
            <Eyebrow style={{ marginBottom: 12 }}>What we offer</Eyebrow>
            <h2 style={{ ...h2, fontSize: 'clamp(26px, 4.5vw, 34px)', fontWeight: 700, letterSpacing: '-0.02em', maxWidth: '24ch' }}>
              Three ways we put AI to work in your business
            </h2>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'repeat(3, 1fr)', gap: 16, marginTop: 32 }}>
            <Reveal delay={0} style={{ display: 'flex' }}><PathCard eyebrow="Offering 01" title="FDE as AI Transformation Lead"
              text="A senior Forward Deployed Engineer embeds with your team and leads your AI transformation, hands-on, from first plan to live system." link="Meet the FDE model" href="fde.html" /></Reveal>
            <Reveal delay={0.1} style={{ display: 'flex' }}><PathCard eyebrow="Offering 02" title="AI Automation Platforms"
              text="One platform that replaces scattered spreadsheets and manual steps, automating the workflows that run your day-to-day operations." link="See the platform" href="custom-platforms.html" /></Reveal>
            <Reveal delay={0.2} style={{ display: 'flex' }}><PathCard eyebrow="Offering 03" title="AI Agents"
              text="Autonomous agents that take real actions inside your tools, doing the work for you, not just answering questions." link="Explore AI agents" href="agents.html" /></Reveal>
          </div>
        </div>
      </section>

      {/* ===== Latest from the blog, arrow-scrolled rail of recent posts ===== */}
      <section style={{ padding: '64px 0' }}>
        <div style={wrap}>
          <Reveal>
            <BlogScroller
              narrow={narrow}
              eyebrow="From the blog"
              title="Latest field notes"
              posts={getBlogPosts().slice(0, 5)}
              viewAllHref="blog.html"
              viewAllLabel="All posts"
            />
          </Reveal>
        </div>
      </section>

      {/* ===== Testimonials, featured quote + expandable collapsed cards ===== */}
      <TestimonialsSection narrow={narrow} wrap={wrap} h2={h2} assetBase={assetBase} />

      {/* ===== Closing CTA ===== */}
      <section style={{
        background: 'url(' + assetBase + 'assets/backgrounds/mesh-dark.png) center/cover no-repeat, var(--gradient-hero)',
        padding: '72px 0',
      }}>
        <Reveal style={{ ...wrap, textAlign: 'center' }}>
          <h2 style={{ fontSize: 'clamp(26px, 5.5vw, 38px)', fontWeight: 800, letterSpacing: '-0.02em', color: '#fff', margin: 0 }}>
            What could your best people do{narrow ? ' ' : <br />}if the work that buries them <span style={{ color: 'var(--kl-mint)' }}>just ran itself?</span>
          </h2>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 28, flexWrap: 'wrap' }}>
            <Button variant="dark-primary" mono>Talk to us</Button>
            <Button variant="dark-ghost" mono>See how we build</Button>
          </div>
        </Reveal>
      </section>

      <Footer logoSrc={assetBase + 'assets/logos/KL-Logo-Short-White.png'} />
    </div>
  );
}

/* Client logo marquee, slow, seamless left-to-right scroll pinned to the
   bottom of the hero. Real client logos, knocked out to a light monochrome
   so they sit cleanly on the Deep Forest field; brighten on hover. */
function HeroLogoMarquee({ rise, wrap, assetBase = './' }) {
  const CLIENTS = [
    'Razorpay', 'Paytm', 'Postman', 'Acceldata', 'Haptik', 'Reliance General Insurance',
    'Hoichoi', 'Bureau', 'eGain', 'Flipspaces', 'Interakt', 'Manipal', 'Decklar',
    'Verity', 'IFL', 'Cashflo', 'Flamingo', 'Titan Email', 'Hunger', 'Reeco',
    'Hapivet', 'Ukti', 'oha', 'Space', 'office advisor', 'Minegate', 'hBits', 'CodeKnack',
  ];
  const src = (name) => encodeURI(assetBase + 'assets/client-logos-knockout/' + name + '.png');
  // Some knockout logos read visually smaller at the shared height, bump them up.
  const BIG = {
    'Flipspaces': 44, 'eGain': 44, 'Razorpay': 44, 'Haptik': 44,
    'Reliance General Insurance': 44, 'Postman': 44, 'CodeKnack': 44,
    'Space': 64, 'Manipal': 52, 'Flamingo': 26, 'Interakt': 48,
    'Minegate': 24, 'Hunger': 38, 'office advisor': 38,
    'IFL': 38, 'Verity': 38,
  };
  const Logo = ({ name }) => {
    const h = BIG[name] || 30;
    return (
      <img src={src(name)} alt={name} loading="lazy" style={{
        height: h, width: 'auto', maxWidth: h > 30 ? 230 : 168, objectFit: 'contain', display: 'block',
        flexShrink: 0, opacity: 0.6, transition: 'opacity .25s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }} />
    );
  };
  const loop = [...CLIENTS, ...CLIENTS];
  return (
    <div style={{ position: 'relative', zIndex: 2, width: '100%', paddingBottom: 'clamp(20px, 3vw, 34px)', ...(rise ? rise(0.6) : {}) }}>
      <div style={{ ...wrap }}>
        <div style={{
          fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)', fontSize: 11,
          letterSpacing: '0.24em', textTransform: 'uppercase', color: 'rgba(126,151,141,0.85)',
          textAlign: 'center', marginBottom: 20,
        }}>Trusted by teams shipping in production</div>
      </div>
      <div style={{
        position: 'relative', overflow: 'hidden',
        WebkitMaskImage: 'linear-gradient(90deg, transparent 0, #000 9%, #000 91%, transparent 100%)',
        maskImage: 'linear-gradient(90deg, transparent 0, #000 9%, #000 91%, transparent 100%)',
      }}>
        <div className="kl-marquee-track" style={{
          display: 'flex', alignItems: 'center', gap: 'clamp(40px, 5vw, 72px)',
          width: 'max-content', animation: 'klMarquee 72s linear infinite reverse',
        }}>
          {loop.map((name, i) => <Logo key={i} name={name} />)}
        </div>
      </div>
    </div>
  );
}

/* Live agent-orchestration mesh, an orchestrator hub dispatches glowing
   data packets out to agent nodes and their workers,
   flowing continuously along the network (echoes the isometric connectors). */
function HeroAgentMesh() {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const section = canvas.parentElement;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, dpr = 1, time = 0;
    let nodes = [], edges = [], packets = [], graph = null;
    const mouse = { x: 0, y: 0 }, off = { x: 0, y: 0 };
    let spawnAcc = 0;
    const AC = '106,241,176';
    const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function build() {
      W = section.clientWidth; H = section.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      nodes = []; edges = []; packets = []; spawnAcc = 0;
      const edgeMap = {};
      const narrow = W < 760;
      const cx = narrow ? W * 0.5 : W * 0.68;
      const cy = H * 0.5;
      const R = Math.min(W, H) * (narrow ? 0.3 : 0.25);
      const addNode = (x, y, r, depth, kind) => {
        nodes.push({ x0: x, y0: y, x, y, r, depth, kind, glow: 0, phase: Math.random() * Math.PI * 2, sp: rnd(0.25, 0.6), amp: rnd(1.2, 3.2) });
        return nodes.length - 1;
      };
      const addEdge = (a, b) => {
        const k = a < b ? a + '-' + b : b + '-' + a;
        if (edgeMap[k]) return;
        const e = { a, b, glow: 0 };
        edges.push(e); edgeMap[k] = e; edgeMap[a + '>' + b] = e; edgeMap[b + '>' + a] = e;
      };
      const hub = addNode(cx, cy, 6.5, 0.12, 'hub');
      const primCount = narrow ? 6 : 7;
      const primaries = [], workersOf = {};
      for (let i = 0; i < primCount; i++) {
        const ang = (i / primCount) * Math.PI * 2 - Math.PI / 2 + rnd(-0.16, 0.16);
        const rr = R * rnd(0.88, 1.18);
        const p = addNode(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 0.94, 3.4, 0.32, 'primary');
        primaries.push({ i: p, ang }); addEdge(hub, p);
      }
      for (let i = 0; i < primCount; i++) if (Math.random() < 0.55) addEdge(primaries[i].i, primaries[(i + 1) % primCount].i);
      primaries.forEach(({ i: pi, ang }) => {
        const n = 2 + (Math.random() < 0.5 ? 1 : 0);
        workersOf[pi] = [];
        for (let k = 0; k < n; k++) {
          const a = ang + rnd(-0.42, 0.42);
          const rr = R * rnd(1.5, 2.15);
          const w = addNode(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.94, 2.1, 0.6, 'worker');
          workersOf[pi].push(w); addEdge(pi, w);
        }
      });
      const amb = narrow ? 6 : 13;
      for (let i = 0; i < amb; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const w = addNode(x, y, 1.4, 0.85, 'ambient');
        if (Math.random() < 0.7) {
          let best = -1, bd = Infinity;
          for (let j = 0; j < nodes.length - 1; j++) {
            const dx = nodes[j].x0 - x, dy = nodes[j].y0 - y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = j; }
          }
          if (best >= 0) addEdge(best, w);
        }
      }
      graph = { hub, primaries, workersOf, edgeMap };
    }

    function spawn() {
      const { hub, primaries, workersOf } = graph;
      const p = primaries[(Math.random() * primaries.length) | 0].i;
      const ws = workersOf[p] || [];
      const roll = Math.random();
      let route;
      if (ws.length && roll < 0.6) { const w = ws[(Math.random() * ws.length) | 0]; route = [hub, p, w, p, hub]; }
      else if (roll < 0.85) route = [hub, p, hub];
      else route = [hub, p];
      packets.push({ route, seg: 0, t: 0, dwell: 0 });
    }

    function update(dt) {
      const intensity = 0.55;
      const SPEED = 175 * (0.6 + intensity * 0.95);
      const maxP = 9 + Math.round(intensity * 18);
      const interval = 0.9 - intensity * 0.58;
      spawnAcc += dt;
      while (spawnAcc > interval && packets.length < maxP && graph) { spawn(); spawnAcc -= interval; }
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        if (p.dwell > 0) { p.dwell -= dt; continue; }
        const a = nodes[p.route[p.seg]], b = nodes[p.route[p.seg + 1]];
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        p.t += dt / Math.max(0.32, dist / SPEED);
        if (p.t >= 1) {
          p.t = 0;
          const e = graph.edgeMap[p.route[p.seg] + '>' + p.route[p.seg + 1]];
          if (e) e.glow = Math.min(1, e.glow + 0.95);
          nodes[p.route[p.seg + 1]].glow = Math.min(1.5, nodes[p.route[p.seg + 1]].glow + 1.05);
          p.seg++;
          if (p.seg >= p.route.length - 1) packets.splice(i, 1);
          else p.dwell = (nodes[p.route[p.seg]].kind === 'worker' ? 0.28 : 0.12) * rnd(0.7, 1.4);
        }
      }
      const mShift = 26;
      off.x += (mouse.x * mShift - off.x) * 0.045;
      off.y += (mouse.y * mShift - off.y) * 0.045;
      for (const n of nodes) {
        n.x = n.x0 + Math.sin(time * n.sp + n.phase) * n.amp + off.x * n.depth;
        n.y = n.y0 + Math.cos(time * n.sp * 0.9 + n.phase) * n.amp + off.y * n.depth;
        n.glow *= 0.93;
      }
      for (const e of edges) e.glow *= 0.945;
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b];
        ctx.strokeStyle = 'rgba(' + AC + ',' + (0.045 + e.glow * 0.5) + ')';
        ctx.lineWidth = 0.7 + e.glow * 1.3;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (const n of nodes) {
        const g = n.glow;
        const baseOp = n.kind === 'ambient' ? 0.22 : n.kind === 'worker' ? 0.42 : n.kind === 'primary' ? 0.72 : 0.95;
        const halo = n.r * (2.4 + g * 2.6);
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, halo);
        grad.addColorStop(0, 'rgba(' + AC + ',' + ((0.16 + g * 0.42) * (0.55 + baseOp)) + ')');
        grad.addColorStop(1, 'rgba(' + AC + ',0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(n.x, n.y, halo, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(216,255,236,' + Math.min(1, baseOp + g * 0.5) + ')';
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * (1 + g * 0.3), 0, 6.2832); ctx.fill();
        if (n.kind === 'hub') {
          ctx.strokeStyle = 'rgba(' + AC + ',' + (0.4 + g * 0.4) + ')';
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 7 + Math.sin(time * 1.2) * 1.5, 0, 6.2832); ctx.stroke();
        }
      }
      for (const p of packets) {
        if (p.dwell > 0) continue;
        const a = nodes[p.route[p.seg]], b = nodes[p.route[p.seg + 1]];
        const te = ease(p.t);
        const x = a.x + (b.x - a.x) * te, y = a.y + (b.y - a.y) * te;
        for (let k = 1; k <= 4; k++) {
          const tt = Math.max(0, te - k * 0.045);
          const tx = a.x + (b.x - a.x) * tt, ty = a.y + (b.y - a.y) * tt;
          ctx.fillStyle = 'rgba(' + AC + ',' + (0.14 * (1 - k / 5)) + ')';
          ctx.beginPath(); ctx.arc(tx, ty, 2.6 * (1 - k / 6), 0, 6.2832); ctx.fill();
        }
        const hg = ctx.createRadialGradient(x, y, 0, x, y, 8);
        hg.addColorStop(0, 'rgba(224,255,240,0.95)');
        hg.addColorStop(0.4, 'rgba(' + AC + ',0.7)');
        hg.addColorStop(1, 'rgba(' + AC + ',0)');
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(232,255,244,0.96)';
        ctx.beginPath(); ctx.arc(x, y, 1.9, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    let raf = null, last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; time = now / 1000;
      update(dt); draw();
      raf = requestAnimationFrame(frame);
    };
    const onMove = (e) => {
      const r = section.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
      mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    };
    const onLeave = () => { mouse.x = 0; mouse.y = 0; };
    let rt = null;
    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { build(); if (reduce) draw(); }, 160); };
    const onVis = () => {
      if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
      else if (!reduce && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    };

    build();
    if (reduce) { draw(); }
    else {
      for (let i = 0; i < 5; i++) spawn();
      for (let i = 0; i < 90; i++) update(0.016);
      draw();
      raf = requestAnimationFrame(frame);
    }
    section.addEventListener('mousemove', onMove);
    section.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(rt);
      section.removeEventListener('mousemove', onMove);
      section.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return React.createElement('canvas', { ref, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', zIndex: 0 } });
}

/* Keeps a fixed-coordinate isometric canvas inside its column on every screen:
   measures the available width and scales the scene down (never up) to fit,
   collapsing the wrapper height to match so the layout never overflows. */
function ScaleToFit({ baseWidth, baseHeight, children }) {
  const ref = React.useRef(null);
  const [scale, setScale] = React.useState(1);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / baseWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [baseWidth]);
  return (
    <div ref={ref} style={{ width: '100%', height: baseHeight * scale, display: 'flex', justifyContent: 'center', overflow: 'hidden' }}>
      <div style={{ width: baseWidth, height: baseHeight, flex: 'none', transform: 'scale(' + scale + ')', transformOrigin: 'top center' }}>
        {children}
      </div>
    </div>
  );
}

/* Hand-drawn symbolic icons for the Gantry scene's four capability tiles. Each sits
   on a soft rounded "presence tile" (white-to-mint face, emerald hairline, soft drop
   shadow) so the picture finally matches its caption: a chat bubble for chat, a shield
   and check for approval, a clock with a recall arc for memory, a padlock for privacy.
   Brand colors only; sized to read at scene scale. */
function Glyph({ kind, size = 74 }) {
  const EM = 'var(--kl-emerald, #1C6B49)';
  const MINT = 'var(--kl-mint, #6AF1B0)';
  const DEEP = 'var(--kl-deep-forest, #0C3529)';
  const fid = 'gl-' + kind;
  const sym = {
    chat: (
      <g fill="none" stroke={EM} strokeWidth="2" strokeLinejoin="round">
        <path d="M26 30 h28 a5 5 0 0 1 5 5 v9 a5 5 0 0 1 -5 5 h-16 l-7 6 v-6 h-0 a5 5 0 0 1 -5 -5 v-9 a5 5 0 0 1 5 -5 Z" fill="#fff" />
        <circle cx="34" cy="39.5" r="2.1" fill={MINT} stroke="none" />
        <circle cx="40" cy="39.5" r="2.1" fill={EM} stroke="none" />
        <circle cx="46" cy="39.5" r="2.1" fill={MINT} stroke="none" />
      </g>
    ),
    shield: (
      <g>
        <path d="M40 24 L53 28.5 V39 C53 47 47 52 40 55 C33 52 27 47 27 39 V28.5 Z" fill={MINT} fillOpacity="0.28" stroke={EM} strokeWidth="2" strokeLinejoin="round" />
        <path d="M34 39.5 l4.4 4.4 L47 34.5" fill="none" stroke={EM} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    ),
    memory: (
      <g fill="none" stroke={EM} strokeLinecap="round" strokeLinejoin="round">
        {/* recall arc sweeping over the top-left, ending in a small drawn head */}
        <path d="M28 33 A13 13 0 1 0 33 28.5" strokeWidth="2" />
        <path d="M28 33 L27.5 27 M28 33 L34 32.5" strokeWidth="2" />
        {/* clock face + hands */}
        <circle cx="42" cy="41" r="11" fill="#fff" strokeWidth="2" />
        <path d="M42 41 V34 M42 41 L47 44" strokeWidth="2" />
      </g>
    ),
    lock: (
      <g>
        <path d="M33 38 V33 a8 8 0 0 1 16 0 V38" fill="none" stroke={EM} strokeWidth="2.2" strokeLinecap="round" />
        <rect x="29" y="38" width="24" height="18" rx="4.5" fill={MINT} fillOpacity="0.28" stroke={EM} strokeWidth="2" />
        <circle cx="41" cy="45" r="2.4" fill={DEEP} />
        <rect x="39.7" y="45.5" width="2.6" height="6" rx="1.3" fill={DEEP} />
      </g>
    ),
  };
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      <defs>
        <linearGradient id={fid + '-face'} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#E7FAF0" />
        </linearGradient>
        <filter id={fid + '-sh'} x="-45%" y="-30%" width="190%" height="200%">
          <feDropShadow dx="0" dy="6" stdDeviation="5" floodColor="#0C3529" floodOpacity="0.16" />
        </filter>
      </defs>
      <rect x="11" y="9" width="58" height="58" rx="16" fill={'url(#' + fid + '-face)'} stroke={EM} strokeWidth="1.4" filter={'url(#' + fid + '-sh)'} />
      <rect x="17" y="14" width="46" height="12" rx="6" fill="#FFFFFF" opacity="0.5" />
      {sym[kind]}
    </svg>
  );
}

/* The Gantry "teammate" scene beside the band copy, built as a small staged
   experience rather than a flat diagram: the objects sit on a grounded pad with
   soft contact shadows and a presence glow, the scene assembles itself when it
   scrolls into view (objects rise and settle, threads fade in, light travels the
   threads) and then quietly breathes. Reuses the isometric kit for correct
   geometry; every motion is gated on prefers-reduced-motion. Each callout maps to
   a capability bullet in the band copy. */
function GantryDiagram() {
  const W = 520, H = 440;
  const rootRef = React.useRef(null);
  const [vis, setVis] = React.useState(false);
  const [reduce] = React.useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false);
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (reduce) { setVis(true); return; }
    let done = false;
    const reveal = () => { if (done) return; done = true; cleanup(); setVis(true); };
    const check = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.top < vh * 0.85 && r.bottom > 0) reveal();
    };
    function cleanup() {
      window.removeEventListener('scroll', check, true);
      window.removeEventListener('resize', check);
      clearTimeout(safety);
    }
    window.addEventListener('scroll', check, { capture: true, passive: true });
    window.addEventListener('resize', check);
    const raf = requestAnimationFrame(check);
    const safety = setTimeout(reveal, 1600);
    return () => { cancelAnimationFrame(raf); cleanup(); };
  }, [reduce]);

  const DEEP = 'var(--kl-deep-forest, #0C3529)';
  const EM = 'var(--kl-emerald, #1C6B49)';
  const MINT = 'var(--kl-mint, #6AF1B0)';
  const cap = { marginTop: 12, fontSize: 13.5, lineHeight: 1.4, fontWeight: 600, color: DEEP, letterSpacing: '-0.01em' };
  const unit = { width: 150, textAlign: 'center' };

  // foot center (cx, cy) + radii for each soft contact shadow
  const shadows = [[260, 290, 78, 22], [80, 104, 56, 16], [80, 322, 40, 12], [434, 104, 32, 10], [432, 308, 56, 16]];
  // threads: visible dashed line, the path light travels, and a first-cycle delay
  const links = [
    { d: 'M206,174 L112,100', flow: 'M112,100 L206,174', begin: '1.5s' },
    { d: 'M212,204 L114,300', flow: 'M212,204 L114,300', begin: '2.1s' },
    { d: 'M314,174 L404,100', flow: 'M314,174 L404,100', begin: '1.8s' },
    { d: 'M312,204 L398,300', flow: 'M312,204 L398,300', begin: '2.4s' },
  ];

  const css = `
.gscene .gobj{opacity:0}
.gscene.in .gobj{animation:gRise .85s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--d,0s)}
.gscene .gfloat{will-change:transform}
.gscene.in .gfloat{animation:gFloat var(--f,7s) ease-in-out infinite;animation-delay:var(--fd,1.4s)}
.gscene .gstage,.gscene .gthread{opacity:0}
.gscene.in .gstage{animation:gFade .9s ease both}
.gscene.in .gthread{animation:gFade .7s ease both;animation-delay:.95s}
@keyframes gRise{from{opacity:0;transform:translateY(16px) scale(.965)}to{opacity:1;transform:none}}
@keyframes gFade{from{opacity:0}to{opacity:1}}
@keyframes gFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@media (prefers-reduced-motion:reduce){.gscene .gobj,.gscene .gstage,.gscene .gthread{opacity:1!important;transform:none!important;animation:none!important}.gscene .gfloat{animation:none!important}}`;

  // one callout: outer rises/settles, inner bob floats — separate elements so the
  // two transforms never fight.
  const obj = (key, d, fd, f, node, atx, aty, z) => (
    <IsoAt key={key} x={atx} y={aty} z={z}>
      <div className="gobj" style={{ '--d': d }}>
        <div className="gfloat" style={{ '--f': f, '--fd': fd }}>{node}</div>
      </div>
    </IsoAt>
  );

  return (
    <ScaleToFit baseWidth={W} baseHeight={H}>
      <div ref={rootRef} className={'gscene' + (vis ? ' in' : '')} style={{ position: 'relative', width: W, height: H }}>
        <style>{css}</style>

        {/* presence glow behind Gantry */}
        <div className="gstage" aria-hidden="true" style={{
          position: 'absolute', left: 150, top: 78, width: 220, height: 220, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(106,241,176,.32), rgba(106,241,176,0) 68%)',
          filter: 'blur(6px)', zIndex: 0,
        }} />

        {/* stage: grounded pad, floor ripples, soft contact shadows */}
        <svg className="gstage" width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={{ position: 'absolute', inset: 0, overflow: 'visible', zIndex: 1 }} aria-hidden="true">
          <defs>
            <filter id="gSoft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5" /></filter>
          </defs>
          <polygon points="148,290 260,234 372,290 260,346" fill="rgba(28,107,73,.05)" stroke="rgba(28,107,73,.16)" strokeWidth="1" strokeDasharray="4 5" />
          {!reduce ? [0, 1.6].map((b, i) => (
            <g key={i} transform="translate(260,290)">
              <polygon points="0,-26 52,0 0,26 -52,0" fill="none" stroke={MINT} strokeWidth="1.4">
                <animateTransform attributeName="transform" type="scale" values="0.35;1.5" dur="3.2s" begin={b + 's'} repeatCount="indefinite" additive="sum" />
                <animate attributeName="opacity" values=".5;0" dur="3.2s" begin={b + 's'} repeatCount="indefinite" />
              </polygon>
            </g>
          )) : null}
          {shadows.map((s, i) => (
            <ellipse key={i} cx={s[0]} cy={s[1]} rx={s[2]} ry={s[3]} fill={DEEP} opacity="0.13" filter="url(#gSoft)" />
          ))}
        </svg>

        {/* threads from Gantry to each callout + the light that travels them */}
        <svg className="gthread" width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={{ position: 'absolute', inset: 0, overflow: 'visible', zIndex: 2, pointerEvents: 'none' }} aria-hidden="true">
          {links.map((l, i) => (
            <g key={i}>
              <path d={l.d} fill="none" stroke={EM} strokeWidth="1.3" strokeDasharray="4 5" opacity="0.5" />
              {!reduce ? (
                <circle r="3.2" fill={MINT} stroke={EM} strokeWidth="1" opacity="0">
                  <animateMotion path={l.flow} dur="4.6s" begin={l.begin} repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.14;0.85;1" dur="4.6s" begin={l.begin} repeatCount="indefinite" />
                </circle>
              ) : null}
            </g>
          ))}
        </svg>

        {/* Gantry, the teammate at the center */}
        {obj('g', '.15s', '1s', '8s', <IsoAgent size={132} animated={!reduce} label={null} status={null} />, 192, 116, 4)}
        <IsoAt x={190} y={286} z={4}>
          <div className="gobj" style={{ '--d': '.35s', width: 140, textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: DEEP, letterSpacing: '-0.02em' }}>Gantry</div>
            <div style={{ fontSize: 12, color: 'var(--kl-slate, #5F706A)', marginTop: 1 }}>AI employees, onboarded like real ones</div>
          </div>
        </IsoAt>

        {/* top-left: works where you already chat */}
        {obj('tl', '.5s', '1.4s', '6.5s', (
          <div style={unit}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><Glyph kind="chat" /></div>
            <div style={cap}>Works where you already chat</div>
          </div>
        ), 16, 42, 3)}

        {/* bottom-left: remembers how your team works */}
        {obj('bl', '.8s', '2s', '7.5s', (
          <div style={unit}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><Glyph kind="memory" /></div>
            <div style={cap}>Remembers how your team works</div>
          </div>
        ), 16, 236, 3)}

        {/* top-right: asks before it acts */}
        {obj('tr', '.65s', '1.7s', '7s', (
          <div style={unit}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><Glyph kind="shield" /></div>
            <div style={cap}>Asks before it acts</div>
          </div>
        ), 356, 42, 3)}

        {/* bottom-right: private to your company */}
        {obj('br', '.95s', '2.2s', '8.5s', (
          <div style={unit}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><Glyph kind="lock" /></div>
            <div style={cap}>Private to your company</div>
          </div>
        ), 356, 236, 3)}
      </div>
    </ScaleToFit>
  );
}

/* SaaS is dead, light Off-White band. Left: the thesis (stop renting cookie-cutter
   SaaS, build a platform that fits your process). Right: the Satya Nadella BG2 clip.
   Below: proof cards of custom ops platforms we shipped, then two CTAs.
   Brand-true: Emerald accents on light, hairline borders, no mint text on light. */
function SaasIsDeadBand({ narrow, wrap }) {
  const platforms = [
    { client: 'Mining', title: 'Mine-operations platform', text: 'Production, fleet, fuel and compliance for an entire open-cast mine, on one screen.', href: 'Case Study - Operon.dc.html' },
    { client: 'F&B retail', title: 'Store-ops platform', text: 'Replaced spreadsheets and WhatsApp with one system that runs daily operations.', href: 'Case Study - Boondi.dc.html' },
    { client: 'Procurement', title: 'Procurement platform', text: 'Tender discovery, qualification and bid workflow in a single tailored tool.', href: 'Case Study - Procurement Agent.dc.html' },
    { client: 'IT operations', title: 'ITOps platform', text: 'Incident triage, runbooks and approvals built around how the team actually works.', href: 'Case Study - ITOps Agent.dc.html' },
  ];
  return (
    <section style={{ background: 'var(--kl-off-white, #F4F7F6)', borderTop: '1px solid var(--kl-line)', borderBottom: '1px solid var(--kl-line)', padding: 'clamp(56px, 8vw, 92px) 0' }}>
      <div style={{ ...wrap, display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(0,1fr) minmax(0,1.05fr)', gap: narrow ? 32 : 'clamp(40px, 5vw, 64px)', alignItems: 'center' }}>
        {/* ── Left: thesis ── */}
        <Reveal>
          <Eyebrow style={{ marginBottom: 14 }}>The end of cookie-cutter software</Eyebrow>
          <h2 style={{
            fontSize: 'clamp(28px, 4.8vw, 44px)', fontWeight: 800, lineHeight: 1.07,
            letterSpacing: '-0.03em', color: 'var(--kl-deep-forest)', margin: 0, maxWidth: '18ch',
          }}>
            Even Satya Nadella says <span style={{ color: 'var(--kl-emerald)' }}>SaaS is dead.</span>
          </h2>
          <p style={{ fontSize: 'clamp(15px, 1.9vw, 17.5px)', lineHeight: 1.6, color: 'var(--kl-ink-2)', maxWidth: '52ch', margin: '20px 0 0', textWrap: 'pretty' }}>
            Stop paying per seat for cookie-cutter apps like SAP, ServiceNow and Salesforce, then
            bending your business to fit how <em>they</em> work. It is time to build your own
            tailor-made platform that fits your process, instead of forcing a working process to
            adapt to someone else&rsquo;s recipe.
          </p>
          <p style={{ fontSize: 'clamp(15px, 1.9vw, 17.5px)', lineHeight: 1.6, color: 'var(--kl-ink-2)', maxWidth: '52ch', margin: '14px 0 0', textWrap: 'pretty' }}>
            We build custom AI Automation Platforms that run your real operations, on infrastructure
            you own.
          </p>
        </Reveal>

        {/* ── Right: Satya interview embed ── */}
        <Reveal delay={0.12}>
          <div style={{
            position: 'relative', width: '100%', aspectRatio: '16 / 9',
            borderRadius: 10, overflow: 'hidden', border: '1px solid var(--kl-line)',
            boxShadow: '0 18px 50px rgba(12,53,41,.14)', background: '#000',
          }}>
            <iframe
              src="https://www.youtube-nocookie.com/embed/9NtsnzRFJ_o?start=1688&rel=0"
              title="Satya Nadella on BG2, the future of business applications"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--kl-slate, #5F706A)', margin: '12px 0 0' }}>
            Satya Nadella &middot; BG2 with Bill Gurley &amp; Brad Gerstner
          </p>
        </Reveal>
      </div>

      {/* ── Proof: custom platforms we built ── */}
      <div style={{ ...wrap, marginTop: 'clamp(40px, 5vw, 56px)' }}>
        <Reveal>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--kl-emerald)', margin: 0 }}>
            Custom ops platforms we shipped
          </p>
        </Reveal>
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'repeat(4, 1fr)', gap: 16, marginTop: 22 }}>
          {platforms.map((p, i) => (
            <Reveal key={i} delay={i * 0.08} style={{ display: 'flex' }}>
              <Card variant="proof" href={p.href} style={{ width: '100%', height: '100%' }} eyebrow={p.client} title={p.title}>{p.text}</Card>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 36, flexWrap: 'wrap' }}>
            <Button variant="primary" mono href="custom-platforms.html">Explore AI Automation Platforms</Button>
            <a href="sdd.html" style={{ fontSize: 15, fontWeight: 600, color: 'var(--kl-emerald)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              See how SDD transforms Application Development
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* FDE / AI Transformation Lead, dark Deep Forest band that speaks directly to
   the owner-operator who wants AI but doesn't know where to start. Short blurb on
   the AI Transformation Lead service + CTA to the offering page (fde.html).
   Brand-true: Deep Forest surface, Mint accents/highlight on dark only, mono eyebrow. */
function FdeLeadBand({ narrow, wrap, assetBase = './', href = 'fde.html' }) {
  return (
    <section style={{
      position: 'relative', overflow: 'hidden',
      background: 'var(--gradient-hero, radial-gradient(120% 120% at 80% 0%, #114635 0%, #0C3529 45%, #0A2C22 100%))',
      padding: 'clamp(56px, 8vw, 96px) 0',
    }}>
      <img aria-hidden="true" src={assetBase + 'assets/backgrounds/mesh-dark.png'} alt="" style={{
        position: 'absolute', top: 0, left: 0, width: 'min(620px, 58%)', height: '100%',
        objectFit: 'cover', objectPosition: 'left top', opacity: 0.32, pointerEvents: 'none',
        WebkitMaskImage: 'linear-gradient(90deg, #000 0%, transparent 100%)',
        maskImage: 'linear-gradient(90deg, #000 0%, transparent 100%)',
      }} />
      <Reveal style={{ ...wrap, position: 'relative', zIndex: 1, display: 'flex',
        flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <Eyebrow onDark size="md" style={{ marginBottom: 18 }}>FDE as AI Transformation Lead</Eyebrow>
        <h2 style={{
          fontSize: 'clamp(28px, 5vw, 46px)', fontWeight: 800, lineHeight: 1.07,
          letterSpacing: '-0.03em', color: '#fff', margin: 0, maxWidth: '18ch',
        }}>
          Want AI in your organization but not sure where to start?{' '}
          <span style={{ color: 'var(--kl-mint)' }}>Start with an embedded lead.</span>
        </h2>
        <p style={{ fontSize: 'clamp(15px, 1.9vw, 17.5px)', lineHeight: 1.6, color: 'var(--kl-text-on-dark)', maxWidth: '60ch', margin: '22px auto 0', textWrap: 'pretty' }}>
          A senior Forward Deployed Engineer embeds inside your team, finds where AI actually
          pays off, prototypes working solutions in days, and ships them into production. One
          accountable person leading your AI transformation, hands-on, from first plan to live system.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 34, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Button variant="dark-primary" mono href={href}>Explore the FDE model</Button>
          <Button variant="dark-ghost" mono href="contact.html">Talk to us</Button>
        </div>
      </Reveal>
    </section>
  );
}

/* Gantry, the flagship product, given a dedicated feature band directly below
   the hero. Voiced as an AI teammate that learns the business, consistent with
   the Gantry page (gantry.html), not as a framework or runtime. Light premium
   surface so it reads as a distinct launch moment against the dark hero above.
   The right column holds the isometric Gantry architecture diagram.
   Brand-true: Emerald on light, mint never carries text on light. */
function GantryPlatformBand({ narrow, wrap, assetBase = './', href = 'gantry.html' }) {
  const caps = [
    'A seat in Teams, Slack, or Telegram',
    'Only the access they need',
    'A full audit trail',
    'Self-hosted, any model',
  ];
  return (
    <section style={{
      position: 'relative', overflow: 'hidden',
      borderTop: '1px solid var(--kl-line)', borderBottom: '1px solid var(--kl-line)',
      background: '#fff',
      padding: 'clamp(56px, 8.5vw, 100px) 0',
    }}>
      {/* faint emerald glow + brand mesh, top-right, bounds the band as its own surface */}
      <div aria-hidden="true" style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(62% 75% at 88% 22%, rgba(28,107,73,.07), rgba(28,107,73,0) 70%)',
      }} />
      <img aria-hidden="true" src={assetBase + 'assets/backgrounds/mesh-light.png'} alt="" style={{
        position: 'absolute', top: 0, right: 0, width: 'min(560px, 55%)', height: '100%',
        objectFit: 'cover', objectPosition: 'right top', opacity: 0.5, pointerEvents: 'none',
        WebkitMaskImage: 'linear-gradient(270deg, #000 0%, transparent 100%)',
        maskImage: 'linear-gradient(270deg, #000 0%, transparent 100%)',
      }} />

      <Reveal style={{ ...wrap, position: 'relative', zIndex: 1, display: 'grid',
        gridTemplateColumns: narrow ? '1fr' : 'minmax(0,1.04fr) minmax(0,0.96fr)',
        gap: narrow ? 40 : 'clamp(48px, 5.5vw, 76px)', alignItems: 'center' }}>

        {/* ── Left: the announcement ── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
              letterSpacing: '.16em', textTransform: 'uppercase',
              background: 'var(--kl-emerald)', color: '#fff',
              padding: '5px 11px', borderRadius: 999, lineHeight: 1,
            }}>New</span>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600,
              letterSpacing: '.22em', textTransform: 'uppercase', color: 'var(--kl-emerald)',
            }}>Gantry</span>
          </div>

          <h2 style={{
            fontSize: 'clamp(30px, 5.2vw, 48px)', fontWeight: 800, lineHeight: 1.05,
            letterSpacing: '-0.03em', color: 'var(--kl-deep-forest)', margin: 0, maxWidth: '17ch',
          }}>
            Meet Gantry. Onboard AI employees <span style={{ color: 'var(--kl-emerald)' }}>like real ones.</span>
          </h2>

          <p style={{ fontSize: 'clamp(15px, 1.9vw, 17.5px)', lineHeight: 1.55, color: 'var(--kl-ink-2)', maxWidth: '52ch', margin: '18px 0 0' }}>
            Give them a seat in Teams or Slack, only the access they need, a full audit
            trail, and offboarding in one command. Self-hosted, any model. They pick up how
            you like things done and take the repeat work off your plate.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1fr', gap: '12px 28px', margin: '26px 0 0' }}>
            {caps.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span aria-hidden="true" style={{ flexShrink: 0, width: 12, height: 12, borderRadius: '50%', background: 'rgba(28,107,73,.14)', border: '1px solid var(--kl-emerald)', marginTop: 4 }} />
                <span style={{ fontSize: 14.5, lineHeight: 1.4, color: 'var(--kl-deep-forest)', fontWeight: 500 }}>{c}</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 32 }}>
            <Button variant="primary" mono href={href}>Explore Gantry</Button>
          </div>
        </div>

        {/* ── Right: isometric Gantry architecture diagram ── */}
        <div style={{ position: 'relative' }}>
          <GantryDiagram />
        </div>
      </Reveal>
    </section>
  );
}

/* Testimonials, auto-advancing horizontal accordion. One testimonial is
   featured (wide, full quote); the rest collapse to name + "+" + role. The
   featured slot advances on a timer and on hover/click. Brand-true: Inter
   throughout, Emerald accents on a light surface. Quotes are real customer
   testimonials (attributed to the named individuals). */
const TESTIMONIALS = [
  {
    company: 'Haptik', name: 'Swapan Rajdev', title: 'Co-founder & CTO',
    linkedin: 'https://www.linkedin.com/in/swapan-rajdev-64a0591a/',
    quote: 'Since 2019, KnackLabs has been our trusted engineering partner. They helped us build Interakt to transform WhatsApp into a commercial platform and implement intricate chatbots for our clients.',
  },
  {
    company: 'Reeco', name: 'Omri Shalev', title: 'Co-founder & CTO',
    linkedin: 'https://www.linkedin.com/in/omri-shalev-832b4a134',
    quote: 'As an Israel-based startup, scaling with quality, cost-effective engineers is challenging. KnackLabs helped us scale fast with skilled developers. We value their technical expertise and focus on problem-solving.',
  },
  {
    company: 'Fhynix', name: 'Almitra Karnik', title: 'Founder',
    linkedin: 'https://www.linkedin.com/in/karnikalmitra',
    quote: 'The KnackLabs product team helped us identify critical pain points while developing Fhynix. Collaborating for version 1 was effortless, and still remains the same as we develop new versions.',
  },
  {
    company: 'Flipspaces', name: 'Lokesh Bathija', title: 'CTO',
    linkedin: 'https://in.linkedin.com/in/lokeshbathija',
    quote: 'KnackLabs is helping us develop an enterprise SaaS app at scale. In just 3 months, we optimised our tech process by growing to 18+ specialists. We\u2019re impressed by the calibre of the KnackLabs engineers and testers.',
  },
];

function TestimonialsSection({ narrow, wrap, h2, assetBase }) {
  const [active, setActive] = React.useState(0);
  const [paused, setPaused] = React.useState(false);

  // Auto-advance the featured card on a 6s timer. Pauses on hover (a hover/click
  // also promotes that card); the dwell restarts whenever `active` changes so a
  // hover-jump gets its full reading time. Disabled on narrow, cards stack open.
  React.useEffect(() => {
    if (paused || narrow) return;
    const id = setTimeout(() => setActive((a) => (a + 1) % TESTIMONIALS.length), 6000);
    return () => clearTimeout(id);
  }, [active, paused, narrow]);
  return (
    <section style={{ background: '#fff', borderTop: '1px solid var(--kl-line)', padding: '64px 0 72px' }}>
      <div style={wrap}>
        <Reveal>
          <Eyebrow style={{ marginBottom: 12 }}>Customers</Eyebrow>
          <h2 style={h2}>What teams say after we ship</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <div onMouseLeave={() => setPaused(false)} style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: 16, marginTop: 32, alignItems: 'stretch' }}>
            {TESTIMONIALS.map((t, i) => (
              <TestimonialCard key={i} t={t} narrow={narrow}
                active={i === active}
                onActivate={() => { setActive(i); setPaused(true); }} />
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* A single testimonial that morphs between collapsed (narrow: name + "+" + role)
   and featured (wide: full quote revealed). Only WIDTH animates (flex-grow);
   card height is FIXED and the quote cross-fades via opacity from an absolutely
   positioned layer, so text rewrapping during the width change never reflows
   the card (which would cause the "vibration"). The person's name sits at the
   top as the card's identifier; the role sits at the bottom (no logo, no repeat).
   On narrow screens every card is featured and they stack vertically. */
function TestimonialCard({ t, narrow, active, onActivate }) {
  const [hover, setHover] = React.useState(false);
  const EASE = 'cubic-bezier(.45,0,.18,1)';

  // Mobile: vertical accordion, one card open at a time, the rest collapse to
  // a tappable header (company + name·role + a "+" that rotates to a "×"). The
  // body height animates via the grid-rows 0fr→1fr trick so it stays smooth.
  if (narrow) {
    const open = active;
    return (
      <div
        role="button" tabIndex={0} aria-expanded={open}
        aria-label={'Read the ' + t.company + ' testimonial'}
        onClick={onActivate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); } }}
        style={{
          width: '100%', boxSizing: 'border-box', cursor: 'pointer', textAlign: 'left',
          background: 'var(--kl-off-white)',
          border: '1px solid ' + (open ? 'var(--kl-emerald)' : 'var(--kl-line)'),
          borderRadius: 'var(--radius-lg, 14px)',
          padding: '20px 22px', overflow: 'hidden',
          transition: 'border-color .3s ease',
        }}
      >
        {/* Header, always visible; this is the tap target */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--kl-deep-forest)', letterSpacing: '-0.01em', lineHeight: 1.2 }}>{t.company}</div>
            <div style={{ fontSize: 13, color: 'var(--kl-slate)', lineHeight: 1.3, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name} &middot; {t.title}</div>
          </div>
          <span aria-hidden="true" style={{
            flexShrink: 0, width: 34, height: 34, borderRadius: 'var(--radius-md, 10px)',
            background: open ? 'var(--kl-emerald)' : '#fff',
            border: '1px solid ' + (open ? 'var(--kl-emerald)' : 'var(--kl-line)'),
            color: open ? '#fff' : 'var(--kl-emerald)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 300, lineHeight: 1,
            transition: 'background .25s ease, color .25s ease, border-color .25s ease, transform .35s ' + EASE,
            transform: open ? 'rotate(45deg)' : 'none',
          }}>+</span>
        </div>

        {/* Collapsible body, quote + LinkedIn */}
        <div style={{ maxHeight: open ? 520 : 0, opacity: open ? 1 : 0, overflow: 'hidden', transition: 'max-height .5s ' + EASE + ', opacity .35s ease ' + (open ? '.1s' : '0s') }}>
          <div style={{ minHeight: 0 }}>
            <blockquote style={{
              margin: '18px 0 0', fontSize: 'clamp(17px, 4.4vw, 20px)', lineHeight: 1.45,
              letterSpacing: '-0.01em', fontWeight: 500, color: 'var(--kl-deep-forest)', textWrap: 'pretty',
            }}>
              <span style={{ color: 'var(--kl-emerald)', fontWeight: 600 }}>&ldquo;</span>{t.quote}<span style={{ color: 'var(--kl-emerald)', fontWeight: 600 }}>&rdquo;</span>
            </blockquote>
            {t.linkedin ? (
              <a href={t.linkedin} target="_blank" rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 16, fontSize: 13.5, fontWeight: 600, color: 'var(--kl-emerald)', textDecoration: 'none' }}>
                LinkedIn
              </a>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const feat = active && !narrow;
  const big = feat || narrow; // narrow cards are always fully expanded
  const H = 420;
  return (
    <div
      role="button" tabIndex={0} aria-label={'Read the ' + t.company + ' testimonial'}
      onMouseEnter={() => { setHover(true); if (!narrow && !active) onActivate(); }}
      onMouseLeave={() => setHover(false)}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); } }}
      style={{
        flexGrow: narrow ? 0 : (active ? 2.8 : 1), flexShrink: narrow ? 0 : 1, flexBasis: narrow ? 'auto' : 0,
        width: narrow ? '100%' : undefined,
        minWidth: 0, boxSizing: 'border-box', cursor: narrow ? 'default' : 'pointer', textAlign: 'left',
        background: 'var(--kl-off-white)',
        border: '1px solid ' + (feat || hover ? 'var(--kl-emerald)' : 'var(--kl-line)'),
        borderRadius: 'var(--radius-lg, 14px)',
        padding: narrow ? '24px 22px' : '32px 30px',
        display: 'flex', flexDirection: 'column',
        height: narrow ? 'auto' : H, minHeight: narrow ? 0 : H, overflow: narrow ? 'visible' : 'hidden',
        transition: 'flex-grow .6s ' + EASE + ', border-color .3s ease',
      }}
    >
      {/* Company, the card's identifier (replaces the client logo) */}
      <div style={{
        fontSize: feat ? 19 : 16, fontWeight: 700, color: 'var(--kl-deep-forest)',
        letterSpacing: '-0.01em', lineHeight: 1.2,
        transition: 'font-size .4s ' + EASE,
      }}>{t.company}</div>

      {/* Quote layer + "+" affordance, occupies the flexible middle region.
         Quote is absolutely positioned so its rewrapping never changes layout. */}
      <div style={{ position: 'relative', flex: narrow ? 'none' : 1, marginTop: narrow ? 16 : 20 }}>
        <blockquote style={{
          margin: 0, position: narrow ? 'static' : 'absolute', left: 0, right: 0, top: 0, bottom: 0,
          opacity: active ? 1 : 0, pointerEvents: 'none', overflow: narrow ? 'visible' : 'hidden',
          fontSize: narrow ? 'clamp(18px, 4.6vw, 21px)' : 'clamp(16px, 1.55vw, 21px)',
          lineHeight: 1.42, letterSpacing: '-0.01em', fontWeight: 500, color: 'var(--kl-deep-forest)',
          textWrap: 'pretty',
          transition: 'opacity .45s ease ' + (active ? '.1s' : '0s'),
        }}>
          <span style={{ color: 'var(--kl-emerald)', fontWeight: 600 }}>&ldquo;</span>{t.quote}<span style={{ color: 'var(--kl-emerald)', fontWeight: 600 }}>&rdquo;</span>
        </blockquote>
        {!narrow ? (
          <span aria-hidden="true" style={{
            position: 'absolute', left: 0, bottom: 0,
            width: 36, height: 36, borderRadius: 'var(--radius-md, 10px)',
            background: hover && !active ? 'var(--kl-emerald)' : '#fff',
            border: '1px solid ' + (hover && !active ? 'var(--kl-emerald)' : 'var(--kl-line)'),
            color: hover && !active ? '#fff' : 'var(--kl-emerald)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 21, fontWeight: 300, lineHeight: 1,
            opacity: feat ? 0 : 1, pointerEvents: 'none',
            transition: 'opacity .3s ease, background .2s ease, color .2s ease, border-color .2s ease',
          }}>+</span>
        ) : null}
      </div>

      {/* Person + LinkedIn, name and title sit at the bottom; company is up top */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: big ? 15.5 : 14, fontWeight: 700, color: 'var(--kl-deep-forest)', lineHeight: 1.25 }}>{t.name}</div>
        <div style={{ fontSize: big ? 14 : 12.5, color: 'var(--kl-slate)', lineHeight: 1.3, marginTop: 2 }}>{t.title}</div>
        {t.linkedin ? (
          <a href={t.linkedin} target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10,
              fontSize: 13.5, fontWeight: 600, color: 'var(--kl-emerald)', textDecoration: 'none',
              opacity: big ? 1 : 0, pointerEvents: big ? 'auto' : 'none',
              transition: 'opacity .4s ease ' + (big ? '.15s' : '0s'),
            }}>
            LinkedIn
          </a>
        ) : null}
      </div>
    </div>
  );
}

function PathCard({ eyebrow, title, text, link, href }) {
  const [hover, setHover] = React.useState(false);
  const inner = (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      background: '#fff', border: hover ? '1px solid var(--kl-emerald)' : '1px solid var(--kl-border-card, rgba(12,53,41,.10))',
      borderRadius: 'var(--radius-md, 10px)', padding: '20px 22px', boxShadow: 'var(--shadow-card)',
      transition: 'border-color .2s ease, transform .2s ease', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8,
      width: '100%', height: '100%', boxSizing: 'border-box',
      transform: hover ? 'translateY(-3px)' : 'none',
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--kl-emerald)' }}>{eyebrow}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--kl-deep-forest)', lineHeight: 1.25 }} dangerouslySetInnerHTML={{ __html: title }}></div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--kl-ink-2)' }}>{text}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--kl-emerald)', marginTop: 'auto' }}>{link}</div>
    </div>
  );
  if (href) {
    return (
      <a href={href} style={{ display: 'flex', width: '100%', height: '100%', textDecoration: 'none' }}>{inner}</a>
    );
  }
  return inner;
}
