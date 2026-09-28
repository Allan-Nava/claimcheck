#!/usr/bin/env node
// Scores claim detection against evals/claims.jsonl — the labelled set of messages an
// agent actually ends a turn with. No network, no key, no fixtures on disk: this
// measures the lexicons and the withdrawals (hedge, question, reported speech) alone,
// which is the half of the hook where a mistake becomes a false block.
//
//   node evals/run.mjs                 the table
//   node evals/run.mjs --misses        …and every message it got wrong
//   node evals/run.mjs --write         …and evals/results/<date>-claims.json
//
// A false positive here costs a user a blocked turn on an honest message, so precision
// is the number that matters and recall is the one to trade away.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMIT_CLAIM, MERGED_CLAIM, PUSH_CLAIM, RAN_CLAIM, TAG_CLAIM, TEST_CLAIM, claimed, claimedWhat } from '../claimcheck.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const showMisses = argv.includes('--misses')
const write = argv.includes('--write')

const KINDS = { tests: TEST_CLAIM, commit: COMMIT_CLAIM, push: PUSH_CLAIM, tagged: TAG_CLAIM, merged: MERGED_CLAIM, ran: RAN_CLAIM }
// `tagged` and `merged` must also name what they are about; a sentence that matches the
// lexicon but names nothing is not a claim this tool can check.
const NAMES_SOMETHING = new Set(['tagged', 'merged', 'ran'])

const rows = readFileSync(join(HERE, 'claims.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .map((r) => ({ ...r, expected: new Set(r.kind === 'none' ? [] : r.kind.split(',')) }))

const stats = {}
const misses = []
for (const kind of Object.keys(KINDS)) stats[kind] = { tp: 0, fp: 0, fn: 0, tn: 0 }

for (const row of rows) {
  for (const [kind, patterns] of Object.entries(KINDS)) {
    const fired = NAMES_SOMETHING.has(kind) ? claimedWhat(row.message, patterns) !== null : claimed(row.message, patterns) !== null
    const should = row.expected.has(kind)
    if (fired && should) stats[kind].tp++
    else if (fired && !should) {
      stats[kind].fp++
      misses.push({ kind, kindOf: 'false positive', lang: row.lang, message: row.message })
    } else if (!fired && should) {
      stats[kind].fn++
      misses.push({ kind, kindOf: 'missed claim', lang: row.lang, message: row.message })
    } else stats[kind].tn++
  }
}

const div = (a, b) => (b ? a / b : null)
const pct = (x) => (x === null ? '—' : `${(100 * x).toFixed(1)}%`)

const summary = {}
for (const [kind, s] of Object.entries(stats)) {
  const precision = div(s.tp, s.tp + s.fp)
  const recall = div(s.tp, s.tp + s.fn)
  const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null
  summary[kind] = { ...s, precision, recall, f1 }
}

// Per language, whether a claim of any kind was detected at all: the lexicons are the
// only part of this that is language-specific, so a gap shows up here first.
const byLang = {}
for (const row of rows) {
  const l = (byLang[row.lang] ??= { n: 0, right: 0 })
  const fired = new Set(Object.entries(KINDS).filter(([k, p]) => (NAMES_SOMETHING.has(k) ? claimedWhat(row.message, p) : claimed(row.message, p)) !== null).map(([k]) => k))
  l.n++
  const same = fired.size === row.expected.size && [...fired].every((k) => row.expected.has(k))
  if (same) l.right++
}

console.log(`claims.jsonl: ${rows.length} messages, ${rows.filter((r) => r.expected.size).length} carrying a claim\n`)
console.log('kind      tp    fp    fn    tn   precision   recall      f1')
for (const [kind, s] of Object.entries(summary)) {
  console.log(
    `${kind.padEnd(8)}${String(s.tp).padStart(3)}${String(s.fp).padStart(6)}${String(s.fn).padStart(6)}${String(s.tn).padStart(6)}` +
      `${pct(s.precision).padStart(12)}${pct(s.recall).padStart(9)}${pct(s.f1).padStart(8)}`,
  )
}
console.log('\nby language (every kind exactly right on the message)')
for (const [lang, l] of Object.entries(byLang)) console.log(`  ${lang}  ${l.right}/${l.n}  ${pct(l.right / l.n)}`)

if (misses.length) {
  console.log(`\n${misses.length} message(s) scored wrong` + (showMisses ? ':' : ' — run with --misses to see them'))
  if (showMisses) for (const m of misses) console.log(`  [${m.kind}] ${m.kindOf} (${m.lang}): ${m.message}`)
} else {
  console.log('\nnothing scored wrong')
}

const anyFalsePositive = Object.values(summary).some((s) => s.fp > 0)

if (write) {
  const dir = join(HERE, 'results')
  mkdirSync(dir, { recursive: true })
  const at = new Date()
  const file = join(dir, `${at.toISOString().slice(0, 10)}-claims.json`)
  writeFileSync(file, JSON.stringify({ at: at.toISOString(), node: process.version, total: rows.length, summary, byLang, misses }, null, 2) + '\n')
  console.log(`\nwrote ${file}`)
}

// A false positive is a blocked turn on an honest message. CI treats it as a failure;
// a missed claim only costs coverage, and is reported rather than enforced.
process.exit(anyFalsePositive ? 1 : 0)
