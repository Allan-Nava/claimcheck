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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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
  /\b(?:all\s+)?tests?\s+(?:now\s+)?(?:pass(?:es|ed|ing)?|are\s+green|succeed(?:ed)?)\b/i,
  /\btests?\s*:\s*(?:green|passing|passed|pass(?:es)?|ok)\b/i,
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

// A claim is only worth checking when it names what it is about. "I merged it" names
// nothing a session can look up; "I tagged v1.2.3" and "merged #42" name exactly one
// thing each, and that is the difference between a check and a guess.
const TAG_CLAIM = [
  /\b(?:i\s+)?(?:have\s+)?tagged\s+(v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z-]+)*)/i,
  /\breleased\s+(v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z-]+)*)/i,
  /\bho\s+taggato\s+(v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z-]+)*)/i,
  /\brilasciat[oa]\s+(?:la\s+)?(v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z-]+)*)/i,
]

// "I ran the linter" is a sentence; "I ran `npm run lint`" is a claim about the session's
// own record. Only the second is checkable, so only the second is matched: the command
// has to be named, in backticks, by a sentence that says it was run.
const RAN_CLAIM = [
  /\b(?:i\s+)?(?:have\s+)?ran\s+`([^`\n]+)`/i,
  /\b(?:i\s+have\s+run|i've\s+run|i\s+run)\s+`([^`\n]+)`/i,
  /\b(?:i\s+)?(?:have\s+)?executed\s+`([^`\n]+)`/i,
  /\bho\s+(?:eseguito|lanciato)\s+`([^`\n]+)`/i,
]

const MERGED_CLAIM = [
  /\b(?:i\s+)?(?:have\s+)?merged\s+#(\d+)/i,
  /(?:^|[\s(])#(\d+)\s+(?:is\s+)?merged\b/i,
  /\bho\s+mergiato\s+#(\d+)/i,
]

const PUSH_CLAIM = [
  // "pushed back on that suggestion" is an argument, not a git push.
  /\b(?:i\s+)?(?:have\s+)?pushed\b(?!\s+(?:back|\w+\s+over|over)\b)/i,
  /\bho\s+pushat(?:o|i)\b/i,
  /\bpush\s+(?:fatto|eseguito)\b/i,
]

// A hedge anywhere in the sentence withdraws the claim in it: "tests should pass",
// "once the tests pass", "if tests pass". Checked per sentence, not per message.
const HEDGE = /\b(?:should|would|will|expect|once|after|if|when|try|going to|need to|dovrebbero?|se |quando|dopo|prover[òo])\b/i

// Reported speech is somebody else's claim, not the agent's: "the issue says the tests
// pass" describes a ticket, and blocking on it would punish an accurate summary.
const ATTRIBUTION = /\b(?:says?|said|claims?|claimed|reports?|reported|according to|dice|dicono|sostiene|secondo)\b/i

// A negated sentence states the opposite of a claim: "nothing was pushed", "the tests do
// not pass", "non ho committato nulla". Measured on evals/claims.jsonl these were six of
// the eight scoring errors, and every one of them was a false block.
const NEGATION = /\b(?:not|n't|never|no|none|nothing|cannot|unable|without|nulla|niente|nessun[ao]?|non|senza)\b/i

// …but negating a failure asserts success: "369 tests pass, no failures" is a claim, and
// the negation rule above would otherwise withdraw it. Stripped before the test, not
// carved out of it, so "no failures and nothing was pushed" still counts as negated.
const NEGATED_FAILURE = /\b(?:no|without|zero|nessun[aeio]?|senza)\s+(?:failures?|errors?|problems?|issues?|regressions?|warnings?|errori|problemi|regressioni)\b/gi

// A fenced block is output the agent pasted, not a sentence it wrote: a Raft status table
// with a COMMITTED column, or a CI log reading `PR #24 merged`, are not claims by anyone.
// Measured over 670 real stops, this was every false positive the sweep turned up.
// Inline code stays, because `I ran \`npm test\`` names its command that way.
const withoutFences = (text) =>
  String(text)
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/gm, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')

const sentences = (text) => withoutFences(text).split(/(?<=[.!?\n])\s+/)

// The same withdrawals as `claimed`, but returning what the sentence named — the tag,
// the number — because a claim that names nothing cannot be checked.
function claimedWhat(text, patterns) {
  for (const s of sentences(text)) {
    if (HEDGE.test(s)) continue
    if (/\?\s*$/.test(s.trim())) continue
    if (ATTRIBUTION.test(s)) continue
    if (NEGATION.test(s.replace(NEGATED_FAILURE, ' '))) continue
    for (const p of patterns) {
      const m = s.match(p)
      if (m) return { what: m[1], sentence: s.trim().slice(0, 200) }
    }
  }
  return null
}

function claimed(text, patterns) {
  for (const s of sentences(text)) {
    if (HEDGE.test(s)) continue
    if (/\?\s*$/.test(s.trim())) continue // a question about the tests is not a claim about them
    if (ATTRIBUTION.test(s)) continue
    if (NEGATION.test(s.replace(NEGATED_FAILURE, ' '))) continue
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

// A trailing newline terminates the last line; it does not start another. Counting the
// split parts made every file look one line longer, so a citation one past the end went
// unreported and the number in the finding was wrong.
function countLines(text) {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

// A cited path that is missing at cwd may still be a real file one directory up or
// down — `docs/x.md` when the file is at `sub/docs/x.md`. Measured over 140 real
// findings, half were exactly this. Ask git once, and only when something is missing.
// Keyed by repository. A single cache answered for whichever repository asked first,
// which is invisible in the hook — one process, one cwd — but wrong in anything that
// walks several, such as the eval runners in evals/.
const trackedCache = new Map()
function tracksSuffix(cwd, p) {
  if (!trackedCache.has(cwd)) {
    const out = git(cwd, ['ls-files'])
    trackedCache.set(cwd, out === null ? new Set() : new Set(out.split('\n').filter(Boolean)))
  }
  for (const t of trackedCache.get(cwd)) if (t === p || t.endsWith('/' + p)) return true
  return false
}

// --- a command the session never ran ----------------------------------------------
// Off unless asked for. English has many ways of saying "I looked at it" that are not
// claims to have run anything, and this is the check most likely to misfire on them.

// Two commands are the same command when they invoke the same program with the same
// first argument: `npm test` and `npm test -- --watch` are one claim, `npm run lint` and
// `npm run build` are two.
const commandKey = (command) => {
  const words = String(command).trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  // Two words name the command, except after a runner's `run`, where the script name is
  // the third: `npm run lint` and `npm run build` are two commands, not one.
  const n = /^(?:npm|pnpm|yarn|bun)$/i.test(words[0] ?? '') && /^run$/i.test(words[1] ?? '') ? 3 : 2
  return words.slice(0, n).join(' ').toLowerCase()
}

function checkRan(message, runs) {
  const claim = claimedWhat(message, RAN_CLAIM)
  if (!claim) return null
  if (runs === null) return null // no transcript: cannot tell, so say nothing
  const wanted = commandKey(claim.what)
  if (!wanted) return null
  // A pipeline or a compound in the claim is more than one command; the session's own
  // lines are split the same way, so either side matching is enough.
  const ran = new Set()
  for (const r of runs) for (const part of String(r.command).split(/\s*(?:&&|\|\||[;|])\s*/)) ran.add(commandKey(part))
  if (ran.has(wanted)) return null
  return `the message says it ran \`${claim.what}\`, and no command like it appears in this session. Claimed: "${claim.sentence}"`
}

// --- a tag the repository has not got --------------------------------------------

function checkTag(message, cwd) {
  const claim = claimedWhat(message, TAG_CLAIM)
  if (!claim) return null
  if (!isRepo(cwd)) return null
  const tags = git(cwd, ['tag', '--list'])
  if (tags === null) return null
  const have = new Set(tags.split('\n').filter(Boolean))
  if (!have.size) return null // a repository with no tags at all says nothing either way
  // `v1.2.3` and `1.2.3` are the same release written two ways.
  const named = claim.what
  const bare = named.replace(/^v/i, '')
  if (have.has(named) || have.has(bare) || have.has(`v${bare}`)) return null
  return `the message says ${named} was tagged, and this repository has no such tag. Claimed: "${claim.sentence}"`
}

// --- a pull request that is not merged --------------------------------------------
// Off unless asked for: it reaches the network inside a hook's budget, and a stop that
// waits on GitHub is a stop that has stopped being free.

function checkMerged(message, cwd, { timeoutMs = 3000 } = {}) {
  const claim = claimedWhat(message, MERGED_CLAIM)
  if (!claim) return null
  if (!isRepo(cwd)) return null
  let state
  try {
    state = execFileSync('gh', ['pr', 'view', claim.what, '--json', 'state', '-q', '.state'], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null // no gh, not authenticated, no network, no such PR: all say nothing
  }
  if (!state || state === 'MERGED') return null
  return `the message says #${claim.what} was merged, and GitHub reports it as ${state.toLowerCase()}. Claimed: "${claim.sentence}"`
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
        const n = countLines(readFileSync(abs, 'utf8'))
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

// --- audit mode, and the record it leaves ------------------------------------------
//
// The hook either blocks or stays silent, and until now neither was written down — so
// there was no way to answer the two questions that decide whether to keep it switched
// on: how often does it fire, and was it right.
//
// In audit mode every stop is judged for real, logged, and allowed through. In enforce
// mode the same line is written and the block still happens. Either way a failure to
// write is not allowed to matter: the log is a record, never a precondition.

const DATA_DIR = process.env.CLAIMCHECK_DATA || join(homedir(), '.claimcheck')
export const LOG_PATH = join(DATA_DIR, 'decisions.jsonl')
export const isAudit = () => (process.env.CLAIMCHECK_MODE || '').toLowerCase() === 'audit'

function record(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
  } catch {
    /* a record that cannot be written is still not a reason to stall the agent */
  }
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

// What the checks found, each labelled with the check that found it: the block reads the
// same as it always did, and the log and the report can count by check.
export function findingsFor(input) {
  const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
  if (!message.trim()) return null
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const runs = readTranscript(input.transcript_path)
  const paths = process.env.CLAIMCHECK_PATHS === '1'
  return [
    ['tests', checkTests(message, runs ? bashRuns(runs) : null)],
    ['commit', checkCommit(message, cwd)],
    ['push', checkPush(message, cwd)],
    ['tagged', checkTag(message, cwd)],
    // Off unless asked for: the check most likely to misfire on ordinary English.
    ['ran', process.env.CLAIMCHECK_RAN === '1' ? checkRan(message, runs ? bashRuns(runs) : null) : null],
    // Off unless asked for: it reaches the network inside a hook's budget.
    ['merged', process.env.CLAIMCHECK_MERGED === '1' ? checkMerged(message, cwd) : null],
    // Off unless asked for: measured over 669 real stops it fired on 9.6% of them, and
    // about half of those were honest references — a cross-repo path, or one relative to
    // somewhere other than cwd. Precision too low to spend the agent's turn on.
    ['paths', paths ? checkPaths(message, cwd) : null],
  ]
    .filter(([, detail]) => detail)
    .map(([check, detail]) => ({ check, detail }))
}

function decide(input) {
  const findings = findingsFor(input)
  if (!findings?.length) return null
  // Keyed on the message, as it always was: one block per stop.
  if (alreadyBlocked(input.session_id, String(input.last_assistant_message ?? ''))) return null
  return {
    decision: 'block',
    reason: `claimcheck: the session's own record does not support this message. ${findings.map((f, i) => `(${i + 1}) ${f.detail}`).join(' ')} Verify each point and say plainly what is actually done and what is not.`,
  }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

// --- report ---------------------------------------------------------------------

function report() {
  let lines
  try {
    lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    process.stdout.write(`claimcheck: nothing recorded yet at ${LOG_PATH}.\nRun with CLAIMCHECK_MODE=audit for a while, then come back.\n`)
    return
  }
  const rows = []
  for (const l of lines) {
    try {
      rows.push(JSON.parse(l))
    } catch {
      /* a half-written line at the tail is not worth failing the report over */
    }
  }
  if (!rows.length) {
    process.stdout.write(`claimcheck: ${LOG_PATH} holds nothing readable.\n`)
    return
  }

  const byOutcome = {}
  const byCheck = {}
  const byDay = {}
  const sessions = new Set()
  for (const r of rows) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
    for (const c of r.checks ?? []) byCheck[c] = (byCheck[c] ?? 0) + 1
    const day = String(r.at).slice(0, 10)
    byDay[day] ??= { stops: 0, fired: 0 }
    byDay[day].stops++
    if (r.outcome !== 'clear') byDay[day].fired++
    if (r.session) sessions.add(r.session)
  }
  const fired = rows.length - (byOutcome.clear ?? 0)
  const pct = (n) => `${((100 * n) / rows.length).toFixed(2)}%`

  process.stdout.write(`${LOG_PATH}\n`)
  process.stdout.write(`${rows.length} stop${rows.length === 1 ? '' : 's'} recorded across ${sessions.size} session${sessions.size === 1 ? '' : 's'}, ${String(rows[0].at).slice(0, 10)} to ${String(rows[rows.length - 1].at).slice(0, 10)}\n\n`)
  process.stdout.write(`fired on ${fired} of them — ${pct(fired)}\n`)
  for (const [outcome, n] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${outcome.padEnd(12)} ${String(n).padStart(6)}  ${pct(n)}\n`)
  }

  if (Object.keys(byCheck).length) {
    process.stdout.write('\nby check\n')
    for (const [check, n] of Object.entries(byCheck).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${check.padEnd(12)} ${String(n).padStart(6)}  ${pct(n)} of stops\n`)
    }
  }

  const days = Object.entries(byDay).sort()
  if (days.length > 1) {
    process.stdout.write('\nover time\n')
    for (const [day, d] of days.slice(-14)) {
      process.stdout.write(`  ${day}  ${String(d.stops).padStart(5)} stops  ${String(d.fired).padStart(4)} fired\n`)
    }
  }

  const recent = rows.filter((r) => r.outcome !== 'clear').slice(-5)
  if (recent.length) {
    process.stdout.write('\nthe last few, to judge by eye — a rate is not a verdict\n')
    for (const r of recent) {
      for (const f of r.findings ?? []) process.stdout.write(`  ${String(r.at).slice(0, 10)}  ${String(f).slice(0, 140)}\n`)
    }
  }
}

async function main() {
  if (process.argv.includes('report')) {
    report()
    return
  }
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
        'CLAIMCHECK_MODE=audit judges for real, records every stop, and never blocks.',
        'claimcheck report  reads that record: how often it fires, on what, over time.',
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
    const findings = findingsFor(input)
    const audit = isAudit()
    // Every stop is recorded, not only the ones that fire: without the stops that found
    // nothing there is no denominator, and "how often does it fire" has no answer.
    if (findings) {
      record({
        at: new Date().toISOString(),
        session: input.session_id ?? null,
        mode: audit ? 'audit' : 'enforce',
        outcome: findings.length ? (audit ? 'would-block' : 'block') : 'clear',
        checks: findings.map((f) => f.check),
        findings: findings.map((f) => f.detail),
      })
    }
    // Audit judges for real and always falls through; it is how a new lexicon earns the
    // right to block anything.
    if (audit) return
    const out = decide(input)
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {
    /* any surprise at all: stay silent rather than stall the agent */
  }
}

// Importable for tests and for measuring against real transcripts; only the direct
// invocation reads stdin and decides.
export {
  bashRuns, checkCommit, checkMerged, checkPaths, checkPush, checkRan, checkTag, checkTests,
  citedPaths, claimed, claimedWhat, decide,
  COMMIT_CLAIM, MERGED_CLAIM, PUSH_CLAIM, RAN_CLAIM, TAG_CLAIM, TEST_CLAIM,
}

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
