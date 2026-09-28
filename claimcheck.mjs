#!/usr/bin/env node
// claimcheck — a Stop hook that refuses to let a claim of completion stand when the
// session's own record contradicts it. Deterministic: no model, no network, no key.
// It never judges whether work is good, only whether what the message says happened
// actually happened. Node 18+, zero dependencies.
//
//   echo '<stop hook json>' | node claimcheck.mjs
//   node claimcheck.mjs --explain      what it would check, on the last session
//
// Exit 0 always. Silence = nothing to say. A block is one JSON object on stdout.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER_DIR = join(tmpdir(), 'claimcheck')
const MAX_TRANSCRIPT_BYTES = 12 * 1024 * 1024

// --- claim detection ---------------------------------------------------------
// A claim is a claim in whatever language it is made, so every lexicon is always on.
// These are deliberately narrow: they match an assertion that something IS DONE, not
// an offer, a question or a plan. "I'll run the tests" must not match; "tests pass"
// must. Over-matching costs a false block, which is the only failure that hurts.

const TEST_CLAIM = [
  /\b(?:all\s+)?tests?\s+(?:now\s+)?(?:pass(?:es|ing)?|are\s+green|succeed(?:ed)?)\b/i,
  /\b(?:the\s+)?(?:full\s+)?(?:test\s+)?suite\s+(?:is\s+)?(?:green|passing|passes)\b/i,
  /\bi\s+test\s+(?:ora\s+)?pass(?:ano|a)\b/i,
  /\btutti\s+i\s+test\s+pass(?:ano|ati)\b/i,
  /\btest\s+verdi\b/i,
]

const COMMIT_CLAIM = [
  /\b(?:i\s+)?(?:have\s+)?committed\b/i,
  /\bcommitted\s+(?:the|it|them|this)\b/i,
  /\bho\s+committ(?:ato|ati)\b/i,
  /\bcommit(?:tato)?\s+(?:fatto|eseguito)\b/i,
]

const PUSH_CLAIM = [
  /\b(?:i\s+)?(?:have\s+)?pushed\b/i,
  /\bho\s+pushat(?:o|i)\b/i,
  /\bpush\s+(?:fatto|eseguito)\b/i,
]

// A hedge anywhere in the sentence withdraws the claim in it: "tests should pass",
// "once the tests pass", "if tests pass". Checked per sentence, not per message.
const HEDGE = /\b(?:should|would|will|expect|once|after|if|when|try|going to|need to|dovrebbero?|se |quando|dopo|prover[òo])\b/i

// Reported speech is somebody else's claim, not the agent's: "the issue says the tests
// pass" describes a ticket, and blocking on it would punish an accurate summary.
const ATTRIBUTION = /\b(?:says?|said|claims?|claimed|reports?|reported|according to|dice|dicono|sostiene|secondo)\b/i

const sentences = (text) => text.split(/(?<=[.!?\n])\s+/)

function claimed(text, patterns) {
  for (const s of sentences(text)) {
    if (HEDGE.test(s)) continue
    if (/\?\s*$/.test(s.trim())) continue // a question about the tests is not a claim about them
    if (ATTRIBUTION.test(s)) continue
    for (const p of patterns) if (p.test(s)) return s.trim().slice(0, 200)
  }
  return null
}

// --- the session's own record ------------------------------------------------

const TEST_CMD = /(?:^|[;&|]\s*)(?:[\w/.-]*\/)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|[;&|]\s*)(?:pytest|jest|vitest|mocha|tox|rspec|phpunit)\b|(?:^|[;&|]\s*)go\s+test\b|(?:^|[;&|]\s*)cargo\s+test\b|(?:^|[;&|]\s*)node\s+--test\b|(?:^|[;&|]\s*)(?:make|just)\s+test\b|(?:^|[;&|]\s*)(?:ctest|dotnet\s+test|mvn\s+test|gradle\s+test)\b/

function readTranscript(path) {
  if (!path || !existsSync(path)) return null
  try {
    if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return null
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return null
  }
}

// Pair every Bash tool_use with the tool_result that carries its id, so a command's
// fate is known and not guessed. Returns the runs in order.
function bashRuns(lines) {
  const uses = new Map()
  const order = []
  for (const line of lines) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') {
        const run = { id: b.id, command: b.input.command, ok: null, at: e.timestamp ?? null }
        uses.set(b.id, run)
        order.push(run)
      } else if (b.type === 'tool_result' && uses.has(b.tool_use_id)) {
        uses.get(b.tool_use_id).ok = b.is_error !== true
      }
    }
  }
  return order
}

// --- git ---------------------------------------------------------------------

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

const isRepo = (cwd) => git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'

// --- paths -------------------------------------------------------------------
// Only paths the message presents AS paths: a markdown link target or a backticked
// token. A bare word that happens to contain a slash is not evidence of anything.

const SOURCE_EXT = /\.(?:mjs|cjs|jsx?|tsx?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|ya?ml|toml|json|md|html|css|scss)$/i

// `rooted` means the citation carried a directory, so resolving it against cwd is what
// it meant and a miss is a real miss. A bare `foo.mjs` could live in any subdirectory,
// so its absence proves nothing — only its line count is checked, and only if found.
function citedPaths(text) {
  const out = new Map()
  const add = (raw) => {
    if (!raw) return
    const [p, line] = raw.split(':')
    if (!p || /^[a-z]+:/i.test(p) || /[*?<>|"\s]/.test(p) || p.startsWith('~')) return
    // A leading slash in prose is almost always a site route or a URL path, not a file
    // at the filesystem root: measured on 673 real stops, these were false positives.
    if (p.startsWith('/')) return
    // Generated trees are absent whenever nobody has built them, which says nothing
    // about whether the message was honest.
    if (/(?:^|\/)(?:dist|build|out|_site|target|node_modules|coverage|\.next|vendor)\//.test(p)) return
    if (!SOURCE_EXT.test(p)) return
    const n = line && /^\d+$/.test(line) ? Number(line) : null
    const prev = out.get(p)
    out.set(p, { line: Math.max(prev?.line ?? 0, n ?? 0) || null, rooted: p.includes('/') })
  }
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) add(m[1])
  for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1].trim())
  return out
}

// --- the checks --------------------------------------------------------------
// Each returns a string naming the contradiction, or null. A check that cannot
// establish the truth returns null: absence of evidence blocks nothing, except where
// the absence IS the finding (a test claim with no test run).

function checkTests(message, runs) {
  const claim = claimed(message, TEST_CLAIM)
  if (!claim) return null
  if (runs === null) return null // no transcript: cannot tell, so say nothing
  const tests = runs.filter((r) => TEST_CMD.test(r.command))
  if (!tests.length) {
    return `the message says the tests pass, but no test command ran in this session. Claimed: "${claim}"`
  }
  const last = tests[tests.length - 1]
  if (last.ok === false) {
    return `the message says the tests pass, but the last test command in this session failed: \`${last.command.slice(0, 120)}\`. Claimed: "${claim}"`
  }
  return null
}

function checkCommit(message, cwd) {
  const claim = claimed(message, COMMIT_CLAIM)
  if (!claim) return null
  if (!isRepo(cwd)) return null
  const staged = git(cwd, ['diff', '--cached', '--name-only'])
  if (staged === null) return null
  if (staged) {
    const n = staged.split('\n').filter(Boolean).length
    return `the message says a commit was made, but ${n} file${n === 1 ? ' is' : 's are'} still staged and uncommitted. Claimed: "${claim}"`
  }
  return null
}

function checkPush(message, cwd) {
  const claim = claimed(message, PUSH_CLAIM)
  if (!claim) return null
  if (!isRepo(cwd)) return null
  const upstream = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (!upstream) return null // no upstream: nothing to be ahead of
  const ahead = git(cwd, ['rev-list', '--count', '@{u}..HEAD'])
  if (ahead === null || ahead === '0') return null
  return `the message says the work was pushed, but ${ahead} commit${ahead === '1' ? '' : 's'} on this branch ${ahead === '1' ? 'is' : 'are'} still ahead of ${upstream}. Claimed: "${claim}"`
}

// A cited path that is missing at cwd may still be a real file one directory up or
// down — `docs/x.md` when the file is at `sub/docs/x.md`. Measured over 140 real
// findings, half were exactly this. Ask git once, and only when something is missing.
let trackedCache = null
function tracksSuffix(cwd, p) {
  if (trackedCache === null) {
    const out = git(cwd, ['ls-files'])
    trackedCache = out === null ? new Set() : new Set(out.split('\n').filter(Boolean))
  }
  for (const t of trackedCache) if (t === p || t.endsWith('/' + p)) return true
  return false
}

function checkPaths(message, cwd) {
  const cited = citedPaths(message)
  const missing = []
  const short = []
  for (const [p, { line, rooted }] of cited) {
    const abs = resolve(cwd, p)
    if (!existsSync(abs)) {
      if (rooted && !tracksSuffix(cwd, p)) missing.push(p)
      continue
    }
    if (line) {
      try {
        const n = readFileSync(abs, 'utf8').split('\n').length
        if (line > n) short.push(`${p}:${line} (the file has ${n} lines)`)
      } catch {
        /* unreadable: say nothing */
      }
    }
  }
  const out = []
  if (missing.length) out.push(`cites ${missing.length === 1 ? 'a file that does not exist' : 'files that do not exist'}: ${missing.join(', ')}`)
  if (short.length) out.push(`cites ${short.length === 1 ? 'a line' : 'lines'} past the end of the file: ${short.join(', ')}`)
  return out.length ? out.join('; ') : null
}

// --- one block per stop ------------------------------------------------------

function alreadyBlocked(sessionId, message) {
  if (!sessionId) return false
  let hash = 0
  for (let i = 0; i < message.length; i++) hash = (hash * 31 + message.charCodeAt(i)) | 0
  const marker = join(MARKER_DIR, `${sessionId}.${hash >>> 0}`)
  try {
    if (existsSync(marker)) return true
    mkdirSync(MARKER_DIR, { recursive: true })
    writeFileSync(marker, '')
  } catch {
    /* cannot mark: better to risk silence than a loop */
    return false
  }
  return false
}

// --- main --------------------------------------------------------------------

function decide(input) {
  const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
  if (!message.trim()) return null
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const runs = readTranscript(input.transcript_path)
  const findings = [
    checkTests(message, runs ? bashRuns(runs) : null),
    checkCommit(message, cwd),
    checkPush(message, cwd),
    // Off unless asked for: measured over 673 real stops it fired on 11.7% of them, and
    // about half of those were honest references — a cross-repo path, or one relative to
    // somewhere other than cwd. Precision too low to spend the agent's turn on.
    process.env.CLAIMCHECK_PATHS === '1' ? checkPaths(message, cwd) : null,
  ].filter(Boolean)
  if (!findings.length) return null
  if (alreadyBlocked(input.session_id, message)) return null
  return {
    decision: 'block',
    reason: `claimcheck: the session's own record does not support this message. ${findings.map((f, i) => `(${i + 1}) ${f}`).join(' ')} Verify each point and say plainly what is actually done and what is not.`,
  }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  if (process.argv.includes('--explain')) {
    process.stdout.write(
      [
        'claimcheck — deterministic Stop hook. It blocks only on a contradiction it can prove:',
        '  tests   the message says tests pass, but no test ran this session, or the last one failed',
        '  commit  the message says committed, but files are still staged',
        '  push    the message says pushed, but commits are still ahead of the upstream',
        '  paths   the message cites a file that does not exist (opt-in: CLAIMCHECK_PATHS=1)',
        'Everything else is silence. No model, no network, no key. Exit code is always 0.',
        '',
      ].join('\n'),
    )
    return
  }
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch {
    return // malformed stdin: get out of the way
  }
  try {
    const out = decide(input)
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {
    /* any surprise at all: stay silent rather than stall the agent */
  }
}

// Importable for tests and for measuring against real transcripts; only the direct
// invocation reads stdin and decides.
export { bashRuns, checkCommit, checkPaths, checkPush, checkTests, citedPaths, claimed, decide, COMMIT_CLAIM, PUSH_CLAIM, TEST_CLAIM }

// Both sides are resolved through the filesystem before they are compared. npm installs
// the bin as a SYMLINK in node_modules/.bin, so argv[1] is the link while import.meta.url
// is the file it points at: comparing them unresolved made the published 0.1.0 exit 0 in
// silence on every stop, which looks exactly like fail-open working.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  )
}
