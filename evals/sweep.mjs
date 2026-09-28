// What claimcheck would have said across the real transcript history. Counts only,
// plus a sample of each finding so the blocks can be judged by eye.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { checkTests, checkPaths, claimed, TEST_CLAIM, COMMIT_CLAIM, PUSH_CLAIM } from '../claimcheck.mjs'

const root = join(homedir(), '.claude', 'projects')
let sessions = 0, stops = 0, claiming = 0, testBlocks = 0, pathBlocks = 0, commitClaims = 0, pushClaims = 0
const samples = { test: [], path: [] }

for (const proj of readdirSync(root)) {
  const d = join(root, proj)
  let files
  try { if (!statSync(d).isDirectory()) continue; files = readdirSync(d).filter(f => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    let lines
    try { const p = join(d, f); if (statSync(p).size > 12e6) continue; lines = readFileSync(p, 'utf8').split('\n') } catch { continue }
    sessions++
    const uses = new Map(); const runs = []
    let lastText = null, lastRole = null, cwd = null
    for (const line of lines) {
      if (!line) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.cwd && !cwd) cwd = e.cwd
      const c = e.message?.content
      if (!Array.isArray(c)) continue
      if (e.type === 'assistant') {
        for (const b of c) {
          if (b.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') {
            const r = { id: b.id, command: b.input.command, ok: null }; uses.set(b.id, r); runs.push(r)
          }
          if (b.type === 'text' && b.text) lastText = b.text
        }
        lastRole = 'assistant'
      } else if (e.type === 'user') {
        for (const b of c) if (b.type === 'tool_result' && uses.has(b.tool_use_id)) uses.get(b.tool_use_id).ok = b.is_error !== true
        if (c.some(b => b.type === 'text') && lastRole === 'assistant' && lastText) {
          stops++
          const anyClaim = claimed(lastText, TEST_CLAIM) || claimed(lastText, COMMIT_CLAIM) || claimed(lastText, PUSH_CLAIM)
          if (anyClaim) claiming++
          if (claimed(lastText, COMMIT_CLAIM)) commitClaims++
          if (claimed(lastText, PUSH_CLAIM)) pushClaims++
          const t = checkTests(lastText, runs.slice())
          if (t) { testBlocks++; if (samples.test.length < 6) samples.test.push(t.slice(0, 190)) }
          if (cwd && existsSync(cwd)) {
            const p = checkPaths(lastText, cwd)
            if (p) { pathBlocks++; if (samples.path.length < 6) samples.path.push(p.slice(0, 190)) }
          }
          lastText = null
        }
        lastRole = 'user'
      }
    }
  }
}
const pct = (n, d) => d ? `${(100 * n / d).toFixed(2)}%` : '—'
console.log(`sessions        ${sessions}`)
console.log(`stops           ${stops}`)
console.log(`claiming        ${claiming}  (${pct(claiming, stops)} of stops — the rest never reach a check)`)
console.log(`  commit claims ${commitClaims}`)
console.log(`  push claims   ${pushClaims}`)
console.log(`\nwould block:`)
console.log(`  tests         ${testBlocks}  (${pct(testBlocks, stops)} of all stops)`)
console.log(`  paths         ${pathBlocks}  (${pct(pathBlocks, stops)} of all stops)`)
console.log(`\n--- test findings ---`); samples.test.forEach(s => console.log('  • ' + s))
console.log(`\n--- path findings ---`); samples.path.forEach(s => console.log('  • ' + s))
