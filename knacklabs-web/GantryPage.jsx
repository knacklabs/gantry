import React from 'react';
import { Button } from 'components/core/Button.jsx';
import { Eyebrow } from 'components/core/Eyebrow.jsx';
import { SiteHeader } from 'components/navigation/SiteHeader.jsx';
import { Footer } from 'components/navigation/Footer.jsx';

/* Gantry product page — the AI teammate that learns your business.
   Voice: a capable human colleague, not a developer tool. Plain, warm,
   outcome first; no technical vocabulary, no terminal. Narrative: hero, the
   problem with AI tools, Day 1 to veteran arc, personas, what makes it better
   (memory + skills), capabilities showcase, close. Brand rules: Inter,
   Deep Forest + Mint on dark, Emerald on light, mint never carries text on
   light. House style: no em dashes, no arrow glyphs, no hyphenated compounds. */

function useNarrow(bp = 760) {
  const [n, setN] = React.useState(typeof window !== 'undefined' && window.innerWidth < bp);
  React.useEffect(() => {
    const onR = () => setN(window.innerWidth < bp);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, [bp]);
  return n;
}

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

/* Light-surface persona tile — emerald accent on hover, mirrors the homepage
   PathCard idiom (mint never carries text on light). Mono role kicker on top. */
function PersonaCard({ kicker, title, text }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      background: '#fff',
      border: hover ? '1px solid var(--kl-emerald)' : '1px solid var(--kl-border-card, rgba(12,53,41,.10))',
      borderRadius: 'var(--radius-md, 10px)', padding: '20px 22px', boxShadow: 'var(--shadow-card)',
      transition: 'border-color .2s ease, transform .2s ease', display: 'flex', flexDirection: 'column', gap: 8,
      width: '100%', height: '100%', boxSizing: 'border-box', transform: hover ? 'translateY(-3px)' : 'none',
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', color: 'var(--kl-emerald)', textTransform: 'uppercase' }}>{kicker}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--kl-deep-forest)', lineHeight: 1.25 }}>{title}</div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--kl-ink-2)' }}>{text}</div>
    </div>
  );
}

/* Real model families from the catalog (model-catalog.ts +
   model-catalog-openai-compatible.ts wire up Anthropic, OpenAI, Google,
   OpenRouter/Kimi, Groq/Llama, xAI/Grok, DeepSeek and more). On a light surface
   the selected chip uses emerald, never mint, since mint never carries text. */
const MODEL_CHIPS = ['Claude', 'GPT', 'Gemini', 'Kimi', 'DeepSeek', 'Llama', 'Grok'];

/* One capability tile. Generalizes the PersonaCard idiom (white card, hairline
   border, emerald hover lift). Optional `tag` renders a muted status chip (used
   for the one capability still rolling out); optional `chips` renders the model
   family row on the "Choose from leading models" tile. */
function CapabilityCard({ title, text, tag, chips }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      background: '#fff',
      border: hover ? '1px solid var(--kl-emerald)' : '1px solid var(--kl-border-card, rgba(12,53,41,.10))',
      borderRadius: 'var(--radius-md, 10px)', padding: '16px 18px', boxShadow: 'var(--shadow-card)',
      transition: 'border-color .2s ease, transform .2s ease', display: 'flex', flexDirection: 'column', gap: 6,
      width: '100%', height: '100%', boxSizing: 'border-box', transform: hover ? 'translateY(-3px)' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--kl-deep-forest)', lineHeight: 1.3, letterSpacing: '-0.01em' }}>{title}</div>
        {tag ? <span style={{ marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--kl-slate, #5F706A)', background: 'rgba(12,53,41,.06)', borderRadius: 5, padding: '3px 7px', whiteSpace: 'nowrap' }}>{tag}</span> : null}
      </div>
      {text ? <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--kl-ink-2)' }}>{text}</div> : null}
      {chips ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 3 }}>
          {chips.map((c, i) => {
            const sel = i === 0;
            return <span key={i} style={{ fontSize: 12, fontWeight: 600, borderRadius: 7, padding: '4px 9px', whiteSpace: 'nowrap', ...(sel
              ? { background: 'var(--kl-emerald)', color: '#fff', border: '1px solid var(--kl-emerald)' }
              : { background: '#fff', color: 'var(--kl-ink-2)', border: '1px solid var(--kl-border-card, rgba(12,53,41,.16))' }) }}>{c}</span>;
          })}
          <span style={{ fontSize: 12, fontWeight: 600, borderRadius: 7, padding: '4px 9px', color: 'var(--kl-slate, #5F706A)', border: '1px solid var(--kl-border-card, rgba(12,53,41,.16))' }}>and more</span>
        </div>
      ) : null}
    </div>
  );
}

/* Hero demo: a realistic Slack workspace where teammates and Gantry work through
   real scenarios across marketing, sales, and inventory. Channel sidebar, a real
   header with topic + members, multiple people talking, emoji reactions, a result
   the agent posts, and the real ask_user_question buttons. Messages stream in one
   at a time, then the next channel's conversation plays. Honors reduced motion
   (renders the first conversation in full, no cycling). */
function HeroConversation({ narrow }) {
  const SIDEBAR = ['growth', 'sales', 'support', 'general'];
  const TOPIC = { growth: 'Campaigns and demand gen', sales: 'Pipeline and renewals', support: 'Customer questions and tickets' };
  const conversations = [
    { channel: 'growth', members: [{ i: 'PR', c: '#E8A06B' }, { i: 'TM', c: '#5BB89A' }], messages: [
      { from: 'Priya', role: 'human', color: '#E8A06B', initials: 'PR', time: '9:41', text: 'morning 👋 can we get the spring campaign numbers before the 10am sync?' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '9:42', tools: [{ app: 'HubSpot', badge: 'HS', color: '#FF7A59', text: 'Pulled spring campaign data from' }], text: 'Here is spring vs last quarter:\n•  Signups up 22%\n•  Cost per lead down 18%\n•  LinkedIn drove 61% of signups', reactions: [{ e: '🎉', n: 2 }] },
      { from: 'Tom', role: 'human', color: '#5BB89A', initials: 'TM', time: '9:42', text: 'LinkedIn is carrying us this quarter 🔥' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '9:43', ask: { header: 'Recap', question: 'Want me to draft a recap for #leadership while this is fresh?', buttons: ['Include the breakdown', 'Keep it short'], picked: 'Include the breakdown' } },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '9:44', text: 'Posted in #leadership and tagged you ✓' },
    ] },
    { dm: true, person: { name: 'Alex Rivera', role: 'CEO', initials: 'AR', color: '#E0A458' }, members: [{ i: 'AR', c: '#E0A458' }], messages: [
      { from: 'Alex', role: 'human', color: '#E0A458', initials: 'AR', time: '7:58', text: 'morning. can you get me ready for the 9am board call?' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '7:59', tools: [
        { app: 'Salesforce', badge: 'SF', color: '#00A1E0', text: 'Pulled pipeline and revenue from' },
        { app: 'Stripe', badge: 'ST', color: '#635BFF', text: 'Pulled the cash position from' },
        { app: 'HubSpot', badge: 'HS', color: '#FF7A59', text: 'Pulled the marketing funnel from' },
      ], text: 'Here is where the business stands this morning:\n•  ARR $1.24M, up 9% this month\n•  $640k in late stage, 3 deals slipping\n•  14 months of runway\n•  Support CSAT at 94%' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '7:59', text: 'I pulled it into a one page summary for the deck:', quote: { label: 'Board summary · June', body: 'Growth steady at 9% with healthy margins. Pipeline is strong, though three late stage deals are slipping and need a push this week. Cash is comfortable at 14 months. Support quality stays high. Suggested focus: close the slipping deals and lock the Q3 hiring plan.' } },
      { from: 'Alex', role: 'human', color: '#E0A458', initials: 'AR', time: '8:01', text: 'perfect. put it in the board folder and give the team a heads up' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '8:01', perm: { title: 'Allow these actions?', lines: ['Save the summary to the Board 2026 folder', 'Post a short update in #leadership'], context: ['Gantry · chief of staff', 'The agent cannot approve this itself.', 'Reply in 5m'], buttons: ['Allow once', 'Allow always', 'Cancel'], picked: 'Allow once' } },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '8:02', tools: [
        { app: 'Google Drive', badge: 'GD', color: '#1FA463', text: 'Saved the summary to' },
        { app: 'Google Calendar', badge: 'GC', color: '#4285F4', text: 'Added an 8:45 prep slot in' },
      ], text: 'Done ✓ Posted to #leadership and pinged Marcus about the 3 slipping deals. You are set for 9am.' },
    ] },
    { channel: 'sales', members: [{ i: 'MA', c: '#6BA9E8' }, { i: 'LN', c: '#E07BA8' }], messages: [
      { from: 'Marcus', role: 'human', color: '#6BA9E8', initials: 'MA', time: '2:15', text: 'where did we land with Northwind on the renewal?' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '2:16', tools: [{ app: 'Salesforce', badge: 'SF', color: '#00A1E0', text: 'Pulled the Northwind opportunity from' }], text: 'Renewal is up in 11 days, worth $48k. They opened the quote twice last week, then went quiet for six days.' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '2:16', text: 'I can send Dana a short follow up that points back to your May 3 call:', quote: { label: 'Draft follow up to Dana', body: 'Hi Dana, circling back on the renewal we talked through on our May 3 call. Happy to walk your team through the new usage tier if that helps. Are you free Thursday for 15 minutes?' } },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '2:16', ask: { header: 'Northwind renewal', question: 'Want me to send this now, or will you call?', buttons: ['Send it now', 'I will call them'], picked: 'Send it now' } },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '2:17', text: 'Sent ✓ I will nudge you on Friday if Dana has not replied.' },
      { from: 'Lena', role: 'human', color: '#E07BA8', initials: 'LN', time: '2:17', text: 'nice, that one has been slipping 🙌', reactions: [{ e: '👍', n: 1 }] },
    ] },
    { channel: 'support', members: [{ i: 'SA', c: '#B58BE8' }, { i: 'KO', c: '#D98E5B' }], messages: [
      { from: 'Gantry', role: 'agent', initials: 'G', time: '10:12', tools: [{ app: 'Zendesk', badge: 'ZD', color: '#78A300', text: 'Read the ticket from Jordan in' }], text: 'A customer is upset about a late order. I drafted a reply that apologizes and offers free shipping on their next order.' },
      { from: 'Sara', role: 'human', color: '#B58BE8', initials: 'SA', time: '10:13', text: 'good call, can I see it before it goes out?' },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '10:13', text: 'Of course, here it is:', quote: { label: 'Draft reply to Jordan', body: 'Hi Jordan, I am sorry order #4021 arrived late. That is on us. Your package is on its way now, and I have added free shipping to your next order. Thank you for bearing with us.' } },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '10:13', perm: { title: 'Allow sending this reply?', lines: ['Reply to Jordan about order #4021', 'Apology and free shipping on the next order'], context: ['Gantry · support agent', 'The agent cannot approve this itself.', 'Reply in 5m'], buttons: ['Allow once', 'Allow always', 'Cancel'], picked: 'Allow once' } },
      { from: 'Gantry', role: 'agent', initials: 'G', time: '10:14', text: 'Sent ✓ and logged it on the ticket.' },
      { from: 'Sara', role: 'human', color: '#B58BE8', initials: 'SA', time: '10:14', text: 'thank you 🙏', reactions: [{ e: '✅', n: 1 }] },
    ] },
  ];

  const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [ci, setCi] = React.useState(0);
  const [shown, setShown] = React.useState(0);
  const [typing, setTyping] = React.useState(false);
  const [manual, setManual] = React.useState(false); // user clicked a channel and is now driving
  const [paused, setPaused] = React.useState(false); // hovering to read
  const msgsRef = React.useRef(null);
  const conv = conversations[ci];
  const channel = conv.channel;
  const dmIdx = conversations.findIndex(cv => cv.dm);

  React.useEffect(() => {
    if (document.getElementById('kl-convo-kf')) return;
    const s = document.createElement('style');
    s.id = 'kl-convo-kf';
    s.textContent = '@keyframes klmsg{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}@keyframes klblink{0%,80%,100%{opacity:.25}40%{opacity:1}}.kl-ch{cursor:pointer}.kl-ch:hover{background:rgba(255,255,255,.06)}.kl-msgs{scrollbar-width:none;-ms-overflow-style:none}.kl-msgs::-webkit-scrollbar{width:0;height:0;display:none}';
    document.head.appendChild(s);
  }, []);

  React.useEffect(() => {
    // Frozen (show the whole conversation, no timers) when the reader is in
    // control: reduced motion, a channel was picked, or the cursor is hovering.
    if (reduce || manual || paused) { setTyping(false); setShown(conv.messages.length); return; }
    const timers = [];
    setShown(0); setTyping(false);
    let t = 700;
    conv.messages.forEach((m, i) => {
      if (m.role === 'agent') {
        timers.push(setTimeout(() => setTyping(true), t)); t += 1000;
        timers.push(setTimeout(() => { setTyping(false); setShown(i + 1); }, t)); t += 850;
      } else {
        timers.push(setTimeout(() => setShown(i + 1), t)); t += 950;
      }
    });
    timers.push(setTimeout(() => setCi((ci + 1) % conversations.length), t + 5200));
    return () => timers.forEach(clearTimeout);
  }, [ci, manual, paused]);

  // Keep the newest message (and the permission card while it is live) in view,
  // so nothing important is clipped at the bottom of the window.
  React.useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown, typing, ci]);

  const optBtn = { fontSize: 13.5, fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.18)', borderRadius: 8, padding: '7px 13px', whiteSpace: 'nowrap' };
  const optSel = { background: 'var(--kl-mint)', color: 'var(--kl-deep-forest)', border: '1px solid var(--kl-mint)' };
  const muted = 'rgba(244,247,246,.55)';

  const avatar = (bg, fg, txt, size) => (
    <div style={{ flexShrink: 0, width: size, height: size, borderRadius: Math.max(5, Math.round(size * 0.22)), background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size > 30 ? 13 : 10 }}>{txt}</div>
  );

  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} style={{ maxWidth: 1040, width: '100%', margin: '0 auto', display: 'flex', textAlign: 'left', background: 'rgba(8,32,25,.6)', border: '1px solid rgba(106,241,176,.16)', borderRadius: 16, boxShadow: 'var(--shadow-float)', overflow: 'hidden', height: narrow ? 'auto' : 580, fontFamily: 'var(--font-sans)' }}>

      {/* Sidebar (desktop only) */}
      {!narrow ? (
        <aside style={{ width: 152, flexShrink: 0, background: 'rgba(5,20,15,.5)', borderRight: '1px solid rgba(255,255,255,.08)', padding: '16px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '2px 8px 14px', borderBottom: '1px solid rgba(255,255,255,.08)', marginBottom: 10 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--kl-mint)', color: 'var(--kl-deep-forest)', fontWeight: 800, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>M</div>
            <span style={{ fontWeight: 700, color: '#fff', fontSize: 14.5 }}>Meridian</span>
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'rgba(244,247,246,.38)', padding: '4px 8px' }}>Channels</div>
          {SIDEBAR.map(c => {
            const active = c === channel;
            const idx = conversations.findIndex(cv => cv.channel === c);
            const clickable = idx >= 0;
            return <div key={c} className={clickable ? 'kl-ch' : undefined}
              onClick={clickable ? () => { setManual(true); setCi(idx); } : undefined}
              style={{ padding: '6px 9px', borderRadius: 7, fontSize: 14.5, color: active ? '#fff' : 'rgba(244,247,246,.6)', fontWeight: active ? 700 : 500, ...(active ? { background: 'rgba(106,241,176,.14)' } : {}) }}>{'# ' + c}</div>;
          })}
          {dmIdx >= 0 ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'rgba(244,247,246,.38)', padding: '14px 8px 4px' }}>Direct messages</div>
              <div className="kl-ch" onClick={() => { setManual(true); setCi(dmIdx); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 7, fontSize: 14.5, color: conv.dm ? '#fff' : 'rgba(244,247,246,.6)', fontWeight: conv.dm ? 700 : 500, ...(conv.dm ? { background: 'rgba(106,241,176,.14)' } : {}) }}>
                {avatar(conversations[dmIdx].person.color, '#fff', conversations[dmIdx].person.initials, 20)}
                {conversations[dmIdx].person.name.split(' ')[0]}
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--kl-mint)' }} />
              </div>
            </>
          ) : null}
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'rgba(244,247,246,.38)', padding: '14px 8px 4px' }}>Apps</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', fontSize: 14.5, color: 'rgba(244,247,246,.78)', fontWeight: 600 }}>
            {avatar('var(--kl-mint)', 'var(--kl-deep-forest)', 'G', 20)} Gantry
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--kl-mint)' }} />
          </div>
        </aside>
      ) : null}

      {/* Main column */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Header: a channel (name + topic) or a direct message (person avatar +
            name + role). Members pinned right. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: narrow ? '14px 16px' : '16px 24px', borderBottom: '1px solid rgba(255,255,255,.10)' }}>
          {conv.dm ? avatar(conv.person.color, '#fff', conv.person.initials, 34) : null}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: '#fff', lineHeight: 1.2 }}>{conv.dm ? conv.person.name : '# ' + channel}</span>
            {!narrow ? <span style={{ fontSize: 13, color: muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{conv.dm ? conv.person.role + ' · Direct message' : TOPIC[channel]}</span> : null}
          </div>
          <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>
            {conv.members.concat([{ i: 'G', agent: true }]).map((mm, mi) => (
              <span key={mi} style={{ width: 24, height: 24, borderRadius: 6, background: mm.agent ? 'var(--kl-mint)' : mm.c, color: mm.agent ? 'var(--kl-deep-forest)' : '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #0a2a20', marginLeft: mi ? -8 : 0 }}>{mm.i}</span>
            ))}
            <span style={{ fontSize: 12, color: muted, marginLeft: 9 }}>{conv.members.length + 1}</span>
          </span>
        </div>

        {/* Messages */}
        <div ref={msgsRef} className="kl-msgs" style={{ flex: 1, minHeight: narrow ? 300 : 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden', padding: narrow ? '16px 22px' : '18px 24px' }}>
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: narrow ? 14 : 16 }}>
          {conv.messages.slice(0, shown).map((m, i) => (
            <div key={ci + '-' + i} style={{ display: 'flex', gap: 12, animation: 'klmsg .42s cubic-bezier(.2,.7,.2,1) both' }}>
              {avatar(m.role === 'agent' ? 'var(--kl-mint)' : m.color, m.role === 'agent' ? 'var(--kl-deep-forest)' : '#fff', m.initials, 38)}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>{m.from}</span>
                  {m.role === 'agent' ? <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.04em', color: 'rgba(244,247,246,.55)', background: 'rgba(255,255,255,.09)', borderRadius: 4, padding: '1px 5px' }}>APP</span> : null}
                  <span style={{ fontSize: 12, color: 'rgba(244,247,246,.42)' }}>{m.time}</span>
                </div>
                {m.tools && m.tools.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5, marginTop: 7 }}>
                    {m.tools.map((tl, ti) => (
                      <div key={ti} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 11px 5px 6px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.09)', borderRadius: 8 }}>
                        <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: 5, background: tl.color, color: '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{tl.badge}</span>
                        <span style={{ fontSize: 12.5, color: 'rgba(244,247,246,.6)' }}>{tl.text} <span style={{ color: 'rgba(244,247,246,.88)', fontWeight: 600 }}>{tl.app}</span></span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {m.text ? <p style={{ fontSize: 15, lineHeight: 1.55, color: 'rgba(244,247,246,.92)', margin: '3px 0 0', whiteSpace: 'pre-line' }}>{m.text}</p> : null}
                {m.quote ? (
                  <div style={{ marginTop: 8, maxWidth: 460, borderLeft: '3px solid var(--kl-mint)', background: 'rgba(255,255,255,.045)', borderRadius: '0 8px 8px 0', padding: '11px 15px' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'rgba(244,247,246,.5)', marginBottom: 6 }}>{m.quote.label}</div>
                    <p style={{ fontSize: 14, lineHeight: 1.55, color: 'rgba(244,247,246,.86)', margin: 0, whiteSpace: 'pre-line' }}>{m.quote.body}</p>
                  </div>
                ) : null}
                {m.ask ? (
                  <div style={{ marginTop: 8, maxWidth: 460 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--kl-mint)', background: 'rgba(106,241,176,.12)', borderRadius: 6, padding: '3px 9px' }}><span aria-hidden="true">&#10067;</span> {m.ask.header}</div>
                    <p style={{ fontSize: 14.5, lineHeight: 1.5, color: 'rgba(244,247,246,.92)', margin: '8px 0 0' }}>{m.ask.question}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                      {m.ask.buttons.map((b, bi) => {
                        const sel = m.ask.picked === b && shown > i + 1;
                        return <span key={bi} style={{ ...optBtn, ...(sel ? optSel : {}) }}>{(bi + 1) + '. ' + b}</span>;
                      })}
                      <span style={{ ...optBtn, color: muted }}>&#9999;&#65039; Other&#8230;</span>
                    </div>
                  </div>
                ) : null}
                {m.perm ? (
                  <div style={{ marginTop: 8, maxWidth: 420, border: '1px solid rgba(255,255,255,.14)', borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,.03)' }}>
                    <div style={{ padding: '12px 15px' }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}><span aria-hidden="true">&#128274;</span> {m.perm.title}</div>
                      {m.perm.lines.map((l, li) => <div key={li} style={{ fontSize: 13.5, lineHeight: 1.45, color: 'rgba(244,247,246,.82)', marginTop: li ? 3 : 7 }}>{l}</div>)}
                      <div style={{ marginTop: 10 }}>
                        {m.perm.context.map((l, li) => <div key={li} style={{ fontSize: 11.5, color: 'rgba(244,247,246,.45)', lineHeight: 1.55 }}>{l}</div>)}
                      </div>
                    </div>
                    <div style={{ borderTop: '1px solid rgba(255,255,255,.1)', padding: '10px 15px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {m.perm.buttons.map((b, bi) => {
                        const sel = m.perm.picked === b && shown > i + 1;
                        const base = b === 'Allow once' ? { ...optBtn, border: '1px solid var(--kl-mint)', background: 'rgba(106,241,176,.16)' } : optBtn;
                        return <span key={bi} style={{ ...base, ...(sel ? optSel : {}) }}>{b}</span>;
                      })}
                    </div>
                  </div>
                ) : null}
                {m.reactions ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {m.reactions.map((rx, ri) => (
                      <span key={ri} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, background: 'rgba(106,241,176,.10)', border: '1px solid rgba(106,241,176,.25)', borderRadius: 20, padding: '2px 9px', color: '#fff' }}>
                        <span>{rx.e}</span><span style={{ color: 'rgba(244,247,246,.7)' }}>{rx.n}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {typing ? (
            <div style={{ display: 'flex', gap: 12, animation: 'klmsg .3s ease both' }}>
              {avatar('var(--kl-mint)', 'var(--kl-deep-forest)', 'G', 38)}
              <div style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,.06)', borderRadius: 12, padding: '11px 13px' }}>
                {[0, 1, 2].map(d => <span key={d} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--kl-mint)', animation: 'klblink 1.1s ' + (d * 0.18) + 's infinite ease-in-out' }} />)}
              </div>
            </div>
          ) : null}
          </div>
        </div>

        {/* Message input */}
        <div style={{ padding: narrow ? '12px 16px' : '14px 24px', borderTop: '1px solid rgba(255,255,255,.10)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid rgba(255,255,255,.16)', borderRadius: 10, padding: '11px 14px' }}>
            <span style={{ flex: 1, color: 'rgba(244,247,246,.32)', fontSize: 14 }}>{conv.dm ? 'Message ' + conv.person.name.split(' ')[0] : 'Message # ' + channel}</span>
            <span style={{ fontSize: 15, opacity: .4 }}>😊</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GantryPage({ assetBase = './' }) {
  const narrow = useNarrow();
  const heroStack = useNarrow(1000);
  const [heroIn, setHeroIn] = React.useState(false);
  React.useEffect(() => { const t = setTimeout(() => setHeroIn(true), 60); return () => clearTimeout(t); }, []);
  const rise = (delay) => ({ opacity: 1, transform: heroIn ? 'none' : 'translateY(14px)', transition: 'transform .8s cubic-bezier(.2,.7,.2,1) ' + delay + 's' });
  const wrap = { maxWidth: 'var(--container-max, 1180px)', margin: '0 auto', padding: '0 clamp(20px, 4.5vw, 32px)', boxSizing: 'border-box' };
  const h2 = { fontSize: 'clamp(22px, 4vw, 26px)', fontWeight: 600, color: 'var(--kl-deep-forest)', margin: 0, letterSpacing: '-0.01em' };
  const h2Big = { ...h2, fontSize: 'clamp(28px, 5vw, 36px)', fontWeight: 700, letterSpacing: '-0.02em' };

  const arc = [
    { k: 'DAY 1', t: 'It shows up', d: 'Arrives in Slack or Teams with a personality, and asks the right question instead of guessing.' },
    { k: 'WEEK 1', t: 'It remembers', d: 'Picks up how you like things done and remembers the calls you make. You stop saying the same things twice.' },
    { k: 'MONTH 1', t: 'It settles in', d: 'The work you do over and over becomes something it just handles, once you approve.' },
  ];
  const engine = [
    { k: 'Memory', t: 'It remembers what matters', d: 'Your preferences, your decisions, the corrections you make along the way. It holds onto them and applies them next time.' },
    { k: 'Skills', t: 'It learns your routines', d: 'The things you ask for again and again become saved routines. You sign off on each one, and the list keeps growing with your team.' },
  ];
  const capabilities = [
    { n: '01', label: 'Works where your team works', items: [
      { title: 'Works in your team chat', text: 'Slack, Microsoft Teams, Telegram, or a web chat.' },
      { title: 'Works from your own app', text: 'Drop a task in, it replies in your product.' },
      { title: 'Runs work on a schedule', text: 'Daily, weekly, once, or on a trigger.' },
      { title: 'Choose from leading models', chips: MODEL_CHIPS },
      { title: 'Runs in your own space', text: 'On your machine or your company cloud.' },
      { title: 'Can greet the public', text: 'On your site, with only safe abilities.' },
    ] },
    { n: '02', label: 'Does the work', items: [
      { title: 'Uses the tools you approve', text: 'Browser, files, and your systems, once cleared.' },
      { title: 'Remembers how you work', text: 'Preferences, decisions, and your corrections.' },
      { title: 'Turns repeat work into routines', text: 'Repeated asks become a saved routine.' },
      { title: 'Delegates the busywork', tag: 'Rolling out', text: 'Splits a big job, returns one result.' },
    ] },
    { n: '03', label: 'You stay in control', items: [
      { title: 'Asks before it acts', text: 'Before anything that matters.' },
      { title: 'Keeps secrets out of reach', text: 'Keys and passwords never reach the model.' },
      { title: 'Leaves a clear receipt', text: 'What it did, what it used, what needs you.' },
      { title: 'Everything on the record', text: 'Every action and approval is logged.' },
      { title: 'Handles gaps gracefully', text: 'Tells you what is missing, never fails silently.' },
    ] },
  ];

  return (
    <div style={{ fontFamily: 'var(--font-sans)', background: 'var(--kl-off-white)', color: 'var(--kl-ink)' }}>
      <SiteHeader assetBase={assetBase} />

      {/* ===== Hero ===== */}
      <section style={{ background: 'var(--gradient-hero)', position: 'relative', overflow: 'hidden', padding: 'clamp(44px, 6vw, 84px) 0' }}>
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(55% 55% at 72% 38%, rgba(106,241,176,.14), rgba(106,241,176,0) 70%)' }} />
        <div style={{ ...wrap, position: 'relative', zIndex: 1, display: 'grid', gridTemplateColumns: heroStack ? '1fr' : 'minmax(0,1fr) minmax(0,1.6fr)', gap: heroStack ? 36 : 48, alignItems: 'center' }}>
          <div style={{ textAlign: heroStack ? 'center' : 'left' }}>
            <Eyebrow onDark size="lg" style={{ marginBottom: 14, ...rise(0.05) }}>An AI teammate, not another tool</Eyebrow>
            <h1 style={{ fontSize: 'clamp(30px, 3.6vw, 48px)', fontWeight: 800, lineHeight: 1.06, letterSpacing: '-0.03em', color: '#fff', margin: heroStack ? '0 auto' : 0, maxWidth: '15ch', ...rise(0.15) }}>
              Not another AI tool.<span style={{ color: 'var(--kl-mint)' }}> A teammate who learns.</span>
            </h1>
            <p style={{ fontSize: 'clamp(15px, 1.6vw, 17px)', lineHeight: 1.55, color: 'var(--kl-text-on-dark)', maxWidth: '46ch', margin: heroStack ? '16px auto 0' : '18px 0 0', ...rise(0.3) }}>
              Most AI forgets you the moment you close the tab. Gantry joins your team in Slack and Microsoft Teams, learns how you like things done, and quietly takes the repeat work off your plate. A new hire on day one, a veteran within a month.
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 26, flexWrap: 'wrap', justifyContent: heroStack ? 'center' : 'flex-start', ...rise(0.45) }}>
              <Button variant="dark-primary" mono>Talk to us</Button>
              <Button variant="dark-ghost" mono>See it work</Button>
            </div>
          </div>
          <div style={{ ...rise(0.4) }}>
            <HeroConversation narrow={narrow} />
            {!narrow ? <div style={{ marginTop: 10, fontSize: 12.5, color: 'rgba(244,247,246,.5)', textAlign: heroStack ? 'center' : 'left' }}>Hover to pause, or pick a channel to follow along.</div> : null}
          </div>
        </div>
      </section>

      {/* ===== The problem with AI tools ===== */}
      <section style={{ padding: '64px 0 56px' }}>
        <Reveal style={{ ...wrap, maxWidth: 880, textAlign: narrow ? 'left' : 'center' }}>
          <Eyebrow style={{ marginBottom: 12 }}>Why it&rsquo;s different</Eyebrow>
          <h2 style={{ ...h2Big, maxWidth: '22ch', margin: narrow ? 0 : '0 auto' }}>You&rsquo;ve tried the AI tools. The work is still on your team.</h2>
          <p style={{ fontSize: 17, lineHeight: 1.6, color: 'var(--kl-ink-2)', maxWidth: '60ch', margin: narrow ? '16px 0 0' : '16px auto 0' }}>
            Every assistant starts from scratch. You explain your business again, spell out every step, and check the work. It never really leaves your plate. A teammate is different. It works alongside you, builds real context, and earns more of your trust over time.
          </p>
        </Reveal>
      </section>

      {/* ===== Day 1 to veteran arc ===== */}
      <section style={{ background: '#fff', borderTop: '1px solid var(--kl-line)', borderBottom: '1px solid var(--kl-line)', padding: '56px 0' }}>
        <div style={wrap}>
          <Reveal>
            <Eyebrow style={{ marginBottom: 12 }}>How it grows</Eyebrow>
            <h2 style={h2}>An intern on Monday. A veteran by month&rsquo;s end.</h2>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'repeat(3, 1fr)', gap: narrow ? 26 : 40, marginTop: 30 }}>
            {arc.map((s, i) => (
              <Reveal key={s.k} delay={i * 0.08}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, letterSpacing: '.1em', color: 'var(--kl-emerald)' }}>{s.k}</div>
                <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--kl-deep-forest)', margin: '10px 0 6px', letterSpacing: '-0.01em' }}>{s.t}</div>
                <div style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--kl-ink-2)' }}>{s.d}</div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Personas ===== */}
      <section style={{ padding: '64px 0' }}>
        <div style={wrap}>
          <Reveal>
            <Eyebrow style={{ marginBottom: 12 }}>Personas</Eyebrow>
            <h2 style={{ ...h2Big, maxWidth: '20ch' }}>It shows up with personality and opinions.</h2>
            <p style={{ fontSize: 17, lineHeight: 1.55, color: 'var(--kl-ink-2)', maxWidth: '58ch', margin: '14px 0 0' }}>
              Choose the personality that fits the role. Each one has its own voice and its own judgment. Gantry holds real opinions and says them plainly. Shape it to match how your team actually works.
            </p>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'repeat(3, 1fr)', gap: 16, marginTop: 28 }}>
            <Reveal delay={0} style={{ display: 'flex' }}><PersonaCard kicker="Operations analyst" title="Meticulous" text="Reads the fine print, double checks the numbers, and flags what does not add up before moving." /></Reveal>
            <Reveal delay={0.06} style={{ display: 'flex' }}><PersonaCard kicker="Executive assistant" title="Decisive" text="Gets to the point, names the risk, and tells you what it would do." /></Reveal>
            <Reveal delay={0.12} style={{ display: 'flex' }}><PersonaCard kicker="Support lead" title="Warm and fast" text="Handles the routine, keeps the tone right, and brings you the hard ones." /></Reveal>
          </div>
        </div>
      </section>

      {/* ===== What makes it better: memory + skills ===== */}
      <section style={{ background: '#fff', borderTop: '1px solid var(--kl-line)', padding: '56px 0 64px' }}>
        <div style={wrap}>
          <Reveal>
            <Eyebrow style={{ marginBottom: 12 }}>What makes it better</Eyebrow>
            <h2 style={h2}>It gets better every week.</h2>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1fr', gap: narrow ? 30 : 64, marginTop: 30 }}>
            {engine.map((s, i) => (
              <Reveal key={s.k} delay={i * 0.08}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, letterSpacing: '.08em', color: 'var(--kl-emerald)', textTransform: 'uppercase' }}>{s.k}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--kl-deep-forest)', margin: '10px 0 8px', letterSpacing: '-0.01em' }}>{s.t}</div>
                <div style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--kl-ink-2)', maxWidth: '46ch' }}>{s.d}</div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Capabilities showcase ===== */}
      <section style={{ borderTop: '1px solid var(--kl-line)', padding: '64px 0 72px' }}>
        <div style={wrap}>
          <Reveal style={{ textAlign: narrow ? 'left' : 'center' }}>
            <Eyebrow style={{ marginBottom: 12 }}>Capabilities</Eyebrow>
            <h2 style={{ ...h2Big, maxWidth: '22ch', margin: narrow ? 0 : '0 auto' }}>Everything you&rsquo;d expect from a great hire.</h2>
            <p style={{ fontSize: 17, lineHeight: 1.6, color: 'var(--kl-ink-2)', maxWidth: '64ch', margin: narrow ? '16px 0 0' : '16px auto 0' }}>
              Gantry gives you an AI employee that works where your team already works, remembers how things should be done, uses only approved abilities, and leaves a receipt for every important action.
            </p>
          </Reveal>
          <div style={{ marginTop: narrow ? 36 : 52, display: 'flex', flexDirection: 'column', gap: narrow ? 40 : 52 }}>
            {capabilities.map(group => (
              <div key={group.n}>
                <Reveal>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, letterSpacing: '.1em', color: 'var(--kl-emerald)' }}>{group.n}</span>
                    <h3 style={{ fontSize: 'clamp(17px, 2.4vw, 21px)', fontWeight: 700, color: 'var(--kl-deep-forest)', margin: 0, letterSpacing: '-0.01em' }}>{group.label}</h3>
                    {!narrow ? <span style={{ flex: 1, height: 1, background: 'var(--kl-line)' }} /> : null}
                  </div>
                </Reveal>
                <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'repeat(3, 1fr)', gap: 16 }}>
                  {group.items.map((it, i) => (
                    <Reveal key={it.title} delay={i * 0.05} style={{ display: 'flex' }}>
                      <CapabilityCard {...it} />
                    </Reveal>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Closing CTA ===== */}
      <section style={{ background: 'url(' + assetBase + 'assets/backgrounds/mesh-dark.png) center/cover no-repeat, var(--gradient-hero)', padding: '72px 0' }}>
        <Reveal style={{ ...wrap, textAlign: 'center' }}>
          <h2 style={{ fontSize: 'clamp(26px, 5.5vw, 38px)', fontWeight: 800, letterSpacing: '-0.02em', color: '#fff', margin: 0, maxWidth: '20ch', marginLeft: 'auto', marginRight: 'auto' }}>
            Give your team a teammate who <span style={{ color: 'var(--kl-mint)' }}>never stops learning.</span>
          </h2>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 28, flexWrap: 'wrap' }}>
            <Button variant="dark-primary" mono>Talk to us</Button>
            <Button variant="dark-ghost" mono>See it work</Button>
          </div>
        </Reveal>
      </section>

      <Footer logoSrc={assetBase + 'assets/logos/KL-Logo-Short-White.png'} />
    </div>
  );
}
