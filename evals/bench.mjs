#!/usr/bin/env node
// What the hook costs. It runs on every stop, so the number that matters is the common
// case — a message with no claim — and how it scales with a long session's transcript.
//
//   node evals/bench.mjs             the table
//   node evals/bench.mjs --write     …and evals/results/<date>-bench.json
//   node evals/bench.mjs --runs 50   more samples per case (default 30)
//
// No network, no key. Node's own startup is measured first and reported beside every
// case, because most of the wall clock is the interpreter and claiming otherwise would
// flatter the hook.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOK = join(dirname(HERE), 'claimcheck.mjs')
const argv = process.argv.slice(2)
const write = argv.includes('--write')
const ri = argv.indexOf('--runs')
const RUNS = ri >= 0 ? Number(argv[ri + 1]) : 30

const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]

function time(fn) {
  const ts = []
  fn() // warm the page cache so the first sample is not the outlier
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint()
    fn()
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  return { p50: q(ts, 0.5), p95: q(ts, 0.95), min: Math.min(...ts), n: RUNS }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

function transcript(dir, n) {
  const lines = []
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'grep -rn foo src/ | head -20' } }] } }))
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(200), is_error: false }] } }))
  }
  const p = join(dir, `t${n}.jsonl`)
  writeFileSync(p, lines.join('\n'))
  return p
}

const dir = mkdtempSync(join(tmpdir(), 'claimcheck-bench-'))
git(dir, 'init', '-q')
git(dir, 'config', 'user.email', 'bench@example.com')
git(dir, 'config', 'user.name', 'bench')
writeFileSync(join(dir, 'a.txt'), 'hello')
git(dir, 'add', 'a.txt')
git(dir, 'commit', '-qm', 'first')

const small = transcript(dir, 100)
const medium = transcript(dir, 1000)
const large = transcript(dir, 10000)

let n = 0
const run = (message, transcript_path) =>
  execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: `bench-${process.pid}-${n++}`, cwd: dir, transcript_path, last_assistant_message: message }),
    encoding: 'utf8',
  })

const NO_CLAIM = 'Here is what I found in the config: the parser reads the header twice.'
const CLAIM = 'Done — all tests pass and I committed it.'

const floor = time(() => execFileSync('node', ['-e', ''], { encoding: 'utf8' }))

const cases = {
  'no claim · 100-command transcript': () => run(NO_CLAIM, small),
  'no claim · 1k-command transcript': () => run(NO_CLAIM, medium),
  'claim · no transcript (cannot know)': () => run(CLAIM, undefined),
  'claim · 100-command transcript': () => run(CLAIM, small),
  'claim · 1k-command transcript': () => run(CLAIM, medium),
  'claim · 10k-command transcript': () => run(CLAIM, large),
}

const results = {}
for (const [name, fn] of Object.entries(cases)) results[name] = time(fn)

console.log(`node ${process.version}, ${RUNS} runs per case, times in ms\n`)
console.log(`node startup alone            p50 ${floor.p50.toFixed(1)}   p95 ${floor.p95.toFixed(1)}`)
console.log('(every case below includes that; the difference is the hook itself)\n')
console.log('case                                    p50      p95    over startup')
for (const [name, r] of Object.entries(results)) {
  console.log(`${name.padEnd(38)}${r.p50.toFixed(1).padStart(5)}${r.p95.toFixed(1).padStart(9)}${(r.p50 - floor.p50).toFixed(1).padStart(14)}`)
}

if (write) {
  const out = join(HERE, 'results')
  mkdirSync(out, { recursive: true })
  const at = new Date()
  const file = join(out, `${at.toISOString().slice(0, 10)}-bench.json`)
  writeFileSync(file, JSON.stringify({ at: at.toISOString(), node: process.version, runs: RUNS, nodeStartup: floor, cases: results }, null, 2) + '\n')
  console.log(`\nwrote ${file}`)
}

rmSync(dir, { recursive: true, force: true })
