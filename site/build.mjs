#!/usr/bin/env node
// Generates site/dist/index.html FROM README.md. The page has no prose of its own:
// every word comes from the README, except the scorecard, which is read off the newest
// run in evals/results/ so it cannot drift from what was actually measured.
//
//   npm run build:site && open site/dist/index.html
//
// `marked` is a devDependency used only here; the published package stays
// dependency-free.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'site', 'dist')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// Inlined so the header paints in one request, and copied to dist as well because the
// favicon and the social card reference it by URL.
const logo = readFileSync(join(ROOT, 'assets', 'logo.svg'), 'utf8').replace(/<\?xml[^>]*\?>/, '').replace(/width="64" height="64"/, 'width="42" height="42" class="mark"').trim()
const REPO = 'https://github.com/Allan-Nava/claimcheck'
const BLOB = `${REPO}/blob/main`

marked.setOptions({ mangle: false, headerIds: false })

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// --- the README, split on its own headings ----------------------------------

function parse(md) {
  // Drop the badges and the H1: the page has its own header, built from them.
  const body = md.replace(/^[\s\S]*?^# claimcheck\n/m, '')
  const parts = body.split(/^## /m)
  const lede = parts.shift().trim()
  return {
    lede,
    sections: parts.map((p) => {
      const nl = p.indexOf('\n')
      return { title: p.slice(0, nl).trim(), body: p.slice(nl + 1).trim() }
    }),
  }
}

// A path in backticks that exists in the repository becomes a link to it. Nothing else
// is rewritten, so the page cannot invent a destination.
function linkifyPaths(html) {
  return html.replace(/<code>([\w./-]+\.(?:mjs|json|md|yml|jsonl))<\/code>/g, (m, p) =>
    existsSync(join(ROOT, p)) ? `<a href="${BLOB}/${p}"><code>${p}</code></a>` : m,
  )
}

// --- the one thing the README does not hold: the newest measured run ---------

function newest(suffix) {
  const dir = join(ROOT, 'evals', 'results')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith(suffix)).sort()
  if (!files.length) return null
  return { name: files[files.length - 1], data: JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')) }
}

function scorecard() {
  const claims = newest('-claims.json')
  const bench = newest('-bench.json')
  if (!claims && !bench) return ''

  const pct = (x) => (x === null || x === undefined ? '—' : `${(100 * x).toFixed(0)}%`)
  let rows = ''
  if (claims) {
    for (const [kind, s] of Object.entries(claims.data.summary)) {
      rows += `<tr><td><code>${esc(kind)}</code></td><td>${pct(s.precision)}</td><td>${pct(s.recall)}</td><td>${s.fp}</td></tr>`
    }
  }

  const cases = bench ? Object.entries(bench.data.cases) : []
  const floor = bench?.data.nodeStartup?.p50 ?? 0
  let lat = ''
  for (const [name, r] of cases) {
    lat += `<tr><td>${esc(name)}</td><td>${r.p50.toFixed(0)} ms</td><td><strong>${(r.p50 - floor).toFixed(0)} ms</strong></td></tr>`
  }

  const when = (claims ?? bench).data.at.slice(0, 10)
  const node = (claims ?? bench).data.node

  // The headline numbers are the case for trusting any of this, and they were cells in a
  // table a reader had to parse. The tables stay underneath.
  const kinds = claims ? Object.keys(claims.data.summary).length : 0
  const worstPrecision = claims ? Math.min(...Object.values(claims.data.summary).map((x) => x.precision ?? 1)) : null
  const common = bench ? Object.entries(bench.data.cases).find(([n]) => /no claim/.test(n))?.[1] : null
  const floorMs = bench?.data.nodeStartup?.p50 ?? 0
  const tiles = [
    claims && [String(claims.data.total), 'labelled messages'],
    claims && [`${(100 * worstPrecision).toFixed(0)}%`, `precision, ${kinds} kind${kinds === 1 ? '' : 's'}`],
    common && [`${(common.p50 - floorMs).toFixed(0)} ms`, 'the hook itself'],
    ['0', 'dependencies'],
  ].filter(Boolean)
  const tileHtml = `<div class="tiles">${tiles.map(([n, l]) => `<div class="tile"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`

  return `
  <section id="measured-run">
    <h2><a class="anchor" href="#measured-run">The last measured run</a></h2>
    <p>Read off <a href="${BLOB}/evals/results">evals/results</a>, not written by hand — ${esc(when)}, Node ${esc(node)}.</p>
    ${tileHtml}
    <div class="cards">
      ${claims ? `<div class="card">
        <h3>Claim detection <span class="dim">${claims.data.total} labelled messages</span></h3>
        <table><thead><tr><th>kind</th><th>precision</th><th>recall</th><th>false pos.</th></tr></thead><tbody>${rows}</tbody></table>
      </div>` : ''}
      ${bench ? `<div class="card">
        <h3>Latency <span class="dim">Node startup is ${floor.toFixed(0)} ms of each</span></h3>
        <table><thead><tr><th>case</th><th>p50</th><th>the hook itself</th></tr></thead><tbody>${lat}</tbody></table>
      </div>` : ''}
    </div>
  </section>`
}

// The hook is one comparison — what the message claims against what the session did —
// and the page had been asking a reader to assemble that from prose.
const DIAGRAM = `
<figure class="fig">
<svg viewBox="0 0 760 232" role="img" aria-labelledby="figt" preserveAspectRatio="xMidYMid meet">
  <title id="figt">A message claims the tests pass; the session ran no test command, so the claim is not supported</title>
  <g class="lbl"><text x="20" y="22">what the message claims</text><text x="440" y="22">what the session did</text></g>

  <g class="box"><rect x="20" y="38" width="320" height="168" rx="10"/></g>
  <text class="fn" x="38" y="64">the last message</text>
  <g class="dim-line"><rect x="38" y="80" width="214" height="7" rx="3.5"/></g>
  <g class="chip"><rect x="38" y="100" width="242" height="32" rx="7"/></g>
  <text class="mono" x="50" y="121">&ldquo;Done, all tests pass.&rdquo;</text>
  <g class="dim-line"><rect x="38" y="148" width="252" height="7" rx="3.5"/><rect x="38" y="166" width="176" height="7" rx="3.5"/></g>

  <g class="box"><rect x="440" y="38" width="300" height="168" rx="10"/></g>
  <text class="fn" x="458" y="64">every Bash it ran</text>
  <text class="mono tree" x="458" y="92">grep -rn foo src/</text>
  <text class="mono tree" x="458" y="116">sed -i s/a/b/ x.mjs</text>
  <text class="mono tree" x="458" y="140">git status</text>
  <text class="mono gone" x="458" y="170">no test command</text>

  <g class="conn">
    <path d="M292 116 L352 116"/>
    <path d="M404 116 L434 116"/>
  </g>
  <circle class="dot" cx="436" cy="116" r="4.5"/>
  <text class="gap" x="371" y="122">?</text>
</svg>
<figcaption>Every check is this comparison, on a different kind of claim.</figcaption>
</figure>`

// --- render ------------------------------------------------------------------

const { lede, sections } = parse(readFileSync(join(ROOT, 'README.md'), 'utf8'))

// The README's badge block is linked images on consecutive lines. The page builds its
// own row from them, so the originals are dropped rather than rendered twice — they came
// out as a strip of shields wedged into the opening paragraph.
const withoutBadges = lede
  .split('\n')
  .filter((line) => !/^\s*(?:\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/.test(line))
  .join('\n')
  .trim()
// The fastest way to understand the hook is the block it writes, which the lede already
// carries — as one of several identical <pre> blocks, with nothing saying this one is the
// point. It gets window chrome, and the checks it names carry a colour.
const CHECK_TINT = /\b(tests|commit|push|tagged|paths|ran|merged)\b/g
function asTerminal(html) {
  let done = false
  return html.replace(/<pre>([\s\S]*?)<\/pre>/, (m, inner) => {
    if (done) return m
    done = true
    return `<div class="term"><div class="bar"><i></i><i></i><i></i><span>Stop</span></div><pre>${inner}</pre></div>`
  })
}

const ledeHtml = asTerminal(linkifyPaths(marked.parse(withoutBadges)))

// A check appears in the table and in the scorecard; one hue each connects them without
// a word of explanation, and the name is always written out so nothing rests on colour.
const CHECK_NAMES = ['tests', 'commit', 'push', 'tagged', 'paths', 'ran', 'merged']
const tintChecks = (html) =>
  html.replace(/<td><code>([a-z]+)<\/code><\/td>/g, (m, name) =>
    CHECK_NAMES.includes(name) ? `<td><code class="ck ck-${name}">${name}</code></td>` : m,
  )

const rendered = sections.map((s) => ({
  title: s.title,
  id: slug(s.title),
  html: `<section id="${slug(s.title)}"><h2><a class="anchor" href="#${slug(s.title)}">${esc(s.title)}</a></h2>${tintChecks(linkifyPaths(marked.parse(s.body)))}</section>`,
}))

// The scorecard goes straight after the section the README calls "Measured". Splicing
// into the list of sections, not into the lines of their concatenated HTML: the earlier
// version split on newlines and inserted the card partway through the first section,
// which emptied that section's heading and spilled the card's table out of its box.
const card = scorecard()
const measuredAt = rendered.findIndex((s) => s.title.toLowerCase() === 'measured')
if (card && measuredAt >= 0) {
  rendered.splice(measuredAt + 1, 0, { title: 'The last measured run', id: 'measured-run', html: card })
} else if (card) {
  rendered.push({ title: 'The last measured run', id: 'measured-run', html: card })
}

const nav = rendered.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join('')
const parts = rendered.map((s) => s.html)

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claimcheck — a Stop hook for unverified claims</title>
<meta name="description" content="${esc(pkg.description)}">
<meta property="og:title" content="claimcheck">
<meta property="og:description" content="${esc(pkg.description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://allan-nava.github.io/claimcheck/">
<meta property="og:image" content="https://allan-nava.github.io/claimcheck/social-preview.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://allan-nava.github.io/claimcheck/social-preview.png">
<link rel="icon" type="image/svg+xml" href="logo.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap">
<style>
:root{
  --bg:#fbfaf8; --fg:#1b1a18; --dim:#6a655e; --rule:#e3ded6;
  --accent:#2f5d8a; --card:#fff; --code:#f3f0ea;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  /* One face, for headings only. The body stays on the system stack: it is already fast
     and readable, and a second download to restate that would be vanity. */
  --display:"Instrument Serif",Georgia,"Times New Roman",serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#141312; --fg:#e8e4dd; --dim:#9a938a; --rule:#2c2a27;
  --accent:#7fb0dd; --card:#1b1a18; --code:#221f1d;
}}
:root[data-theme="dark"]{
  --bg:#141312; --fg:#e8e4dd; --dim:#9a938a; --rule:#2c2a27;
  --accent:#7fb0dd; --card:#1b1a18; --code:#221f1d;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:52rem;margin:0 auto;padding:0 16px}
header{border-bottom:1px solid var(--rule);padding:4rem 0 2.5rem}
.brand{display:flex;align-items:center;gap:.7rem;margin-bottom:.4rem}
.mark{flex:none}
h1{font-family:var(--display);font-size:3.1rem;font-weight:400;margin:0;letter-spacing:-.01em;line-height:1}

/* One hue per check, as tokens so the light theme can restate them: these are chosen
   against a dark background and are too pale on white to read. */
:root{
  --ck-tests:#7fb0dd; --ck-commit:#a3be8c; --ck-push:#b48ead; --ck-tagged:#ebcb8b;
  --ck-paths:#8fbcbb; --ck-ran:#d08770; --ck-merged:#88c0d0;
}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){
  --ck-tests:#2f5d8a; --ck-commit:#4a6d33; --ck-push:#7d4a86; --ck-tagged:#8a6410;
  --ck-paths:#2b6f6b; --ck-ran:#a8532a; --ck-merged:#256b7d;
}}
:root[data-theme="light"]{
  --ck-tests:#2f5d8a; --ck-commit:#4a6d33; --ck-push:#7d4a86; --ck-tagged:#8a6410;
  --ck-paths:#2b6f6b; --ck-ran:#a8532a; --ck-merged:#256b7d;
}
.ck{font-weight:600}
td > code.ck{background:color-mix(in srgb,currentColor 12%,transparent)}
.ck-tests{color:var(--ck-tests)}.ck-commit{color:var(--ck-commit)}.ck-push{color:var(--ck-push)}
.ck-tagged{color:var(--ck-tagged)}.ck-paths{color:var(--ck-paths)}.ck-ran{color:var(--ck-ran)}
.ck-merged{color:var(--ck-merged)}

/* the block it writes, framed as what it is */
.term{border:1px solid var(--rule);border-radius:10px;overflow:hidden;background:var(--code);margin:1.2rem 0}
.term .bar{display:flex;align-items:center;gap:.4rem;padding:.55rem .8rem;border-bottom:1px solid var(--rule);background:color-mix(in srgb,var(--code) 70%,var(--bg))}
.term .bar i{width:10px;height:10px;border-radius:50%;background:var(--rule)}
.term .bar span{margin-left:.5rem;font:500 .78rem var(--mono);color:var(--dim);letter-spacing:.02em}
.term pre{margin:0;border:0;border-radius:0;background:none}

/* the one idea, drawn once */
.fig{margin:1.8rem 0 0;padding:0}
.fig svg{width:100%;height:auto;display:block}
@media (max-width:620px){
  .fig{overflow-x:auto;margin-inline:-16px;padding-inline:16px}
  .fig svg{min-width:600px}
}
.fig figcaption{color:var(--dim);font-size:.85rem;margin-top:.5rem}
.fig .lbl text{fill:var(--dim);font:500 12px var(--sans);letter-spacing:.06em;text-transform:uppercase}
.fig .box rect{fill:var(--card);stroke:var(--rule);stroke-width:1}
.fig .fn{fill:var(--fg);font:600 14px var(--sans)}
.fig .mono{fill:var(--fg);font:13px var(--mono)}
.fig .tree{fill:var(--dim)}
.fig .gone{fill:var(--dim);opacity:.6;font-style:italic}
.fig .dim-line rect{fill:var(--rule)}
.fig .chip rect{fill:color-mix(in srgb,var(--accent) 16%,transparent);stroke:color-mix(in srgb,var(--accent) 45%,transparent)}
.fig .conn path{stroke:var(--accent);stroke-width:2.5;fill:none;stroke-linecap:round}
.fig .dot{fill:var(--accent)}
.fig .gap{fill:var(--dim);font:600 20px var(--sans)}

/* the headline numbers, out of the tables */
.tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:.8rem;margin:1.2rem 0 1.4rem}
@media(min-width:44rem){.tiles{grid-template-columns:repeat(4,1fr)}}
.tile{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:.85rem 1rem}
.tile .n{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.tile .l{color:var(--dim);font-size:.8rem;margin-top:.15rem}
.tag{color:var(--dim);font-size:1.05rem;margin:0}
.lede{font-size:1.1rem;margin-top:1.6rem}
.lede p:first-child{font-size:1.2rem}
.lede p:first-child strong{font-family:var(--display);font-weight:400;font-size:1.45rem;letter-spacing:-.005em}
/* A nav that scrolls away leaves you with no way back by the third section. */
nav{position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;gap:.25rem 1.1rem;padding:.8rem 16px;
    border-bottom:1px solid var(--rule);font-size:.88rem;margin:0 -16px;
    background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);
    overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav a{color:var(--dim);text-decoration:none;white-space:nowrap;padding:.15rem 0;border-bottom:2px solid transparent}
nav a:hover{color:var(--accent)}
nav a.here{color:var(--fg);border-bottom-color:var(--accent)}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
section{scroll-margin-top:3.4rem}
section{padding:2.4rem 0;border-bottom:1px solid var(--rule)}
section:last-child{border-bottom:0}
h2{font-family:var(--display);font-weight:400;font-size:2rem;margin:0 0 1rem;letter-spacing:-.005em;line-height:1.15}
h3{font-size:1.05rem;margin:1.6rem 0 .6rem}
a{color:var(--accent)}
.anchor{color:inherit;text-decoration:none}
.anchor:hover{color:var(--accent)}
code{font-family:var(--mono);font-size:.88em;background:var(--code);padding:.12em .36em;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--code);padding:1rem;border-radius:8px;overflow-x:auto;border:1px solid var(--rule)}
pre code{background:none;padding:0;font-size:.85rem;line-height:1.55;overflow-wrap:normal}
table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.92rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-weight:600;color:var(--dim);font-size:.82rem;text-transform:uppercase;letter-spacing:.04em}
blockquote{margin:1rem 0;padding:.2rem 0 .2rem 1rem;border-left:3px solid var(--rule);color:var(--dim)}
.cards{display:grid;gap:1rem;grid-template-columns:1fr}
@media(min-width:44rem){.cards{grid-template-columns:1fr 1fr}}
.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:1rem 1.1rem}
.card h3{margin-top:0}
.card table{margin:.4rem 0 0}
.dim{color:var(--dim);font-weight:400;font-size:.82rem;display:block;margin-top:.15rem}
footer{padding:2.5rem 0 4rem;color:var(--dim);font-size:.9rem}
footer a{color:var(--dim)}
.badges{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.4rem}
.badges a{display:inline-block;padding:.3rem .7rem;border:1px solid var(--rule);border-radius:999px;font-size:.82rem;text-decoration:none;color:var(--dim)}
.badges a:hover{border-color:var(--accent);color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand">${logo}<h1>claimcheck</h1></div>
  <p class="tag">v${esc(pkg.version)} · <code>${esc(pkg.name)}</code> · MIT</p>
  <div class="lede">${ledeHtml}</div>
  ${DIAGRAM}
  <div class="badges">
    <a href="${REPO}">GitHub</a>
    <a href="https://www.npmjs.com/package/${esc(pkg.name)}">npm</a>
    <a href="${REPO}/actions/workflows/ci.yml">CI</a>
    <a href="${BLOB}/CHANGELOG.md">Changelog</a>
  </div>
</header>
<nav>${nav}</nav>
${parts.join('\n')}
<script>
// Marks the section you are in. IntersectionObserver rather than a scroll handler: it
// does not run on every frame, and it degrades to a plain nav where it is unsupported.
(function () {
  var links = {}, nav = document.querySelector('nav')
  if (!nav || !('IntersectionObserver' in window)) return
  nav.querySelectorAll('a').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a })
  var seen = new Set()
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id) })
    var ids = Object.keys(links).filter(function (id) { return seen.has(id) })
    Object.values(links).forEach(function (a) { a.classList.remove('here') })
    if (ids.length && links[ids[0]]) links[ids[0]].classList.add('here')
  }, { rootMargin: '-20% 0px -70% 0px' })
  document.querySelectorAll('section[id]').forEach(function (s) { io.observe(s) })
  // The last section is short enough that the observation band never reaches it, so at
  // the foot of the page the nav would point at whatever came before.
  addEventListener('scroll', function () {
    if (innerHeight + scrollY < document.body.scrollHeight - 4) return
    var all = Object.values(links)
    all.forEach(function (a) { a.classList.remove('here') })
    if (all.length) all[all.length - 1].classList.add('here')
  }, { passive: true })
})()
</script>
<footer>
  Generated from <a href="${BLOB}/README.md">README.md</a> by
  <a href="${BLOB}/site/build.mjs">site/build.mjs</a>. The page has no prose of its own.
</footer>
</div>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.html'), html)
writeFileSync(join(OUT, '.nojekyll'), '')
for (const asset of ['logo.svg', 'social-preview.png']) {
  const from = join(ROOT, 'assets', asset)
  if (existsSync(from)) copyFileSync(from, join(OUT, asset))
  else console.warn(`build:site: assets/${asset} is missing — the page references it`)
}
console.log(`wrote ${join(OUT, 'index.html')} — ${(html.length / 1024).toFixed(1)} kB, ${sections.length} sections from README.md`)
