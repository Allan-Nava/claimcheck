// Shared fixtures: a fake transcript in the shape Claude Code writes, and one run of
// the hook as a real process, because the hook's contract is stdin in, stdout out.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOOK = join(dirname(dirname(fileURLToPath(import.meta.url))), 'claimcheck.mjs')

// A session id that is unique per process and per call: the hook marks what it has
// blocked, and a reused id would make a test pass by being silenced, not by being right.
let n = 0
export const sessionId = () => `test-${process.pid}-${Date.now()}-${n++}`

export const tmp = () => mkdtempSync(join(tmpdir(), 'claimcheck-'))

// runs: [command, ok][] — each becomes a Bash tool_use and the tool_result carrying its id.
export function transcript(dir, runs) {
  const lines = []
  runs.forEach(([command, ok], i) => {
    const id = `toolu_${i}`
    const at = new Date().toISOString()
    lines.push(JSON.stringify({ type: 'assistant', timestamp: at, cwd: dir, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }))
    lines.push(JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'output', is_error: !ok }] } }))
  })
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.join('\n'))
  return path
}

// Returns the parsed decision, or null when the hook stayed silent.
export function hook(input, env = {}) {
  const out = execFileSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim()
  return out ? JSON.parse(out) : null
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

export function repo() {
  const dir = tmp()
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}
