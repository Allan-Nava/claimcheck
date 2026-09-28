import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { COMMIT_CLAIM, MERGED_CLAIM, PUSH_CLAIM, RAN_CLAIM, TAG_CLAIM, TEST_CLAIM, claimed, claimedWhat } from '../claimcheck.mjs'

const KINDS = { tests: TEST_CLAIM, commit: COMMIT_CLAIM, push: PUSH_CLAIM, tagged: TAG_CLAIM, merged: MERGED_CLAIM, ran: RAN_CLAIM }
const NAMES = new Set(['tagged', 'merged', 'ran'])
const root = join(homedir(), '.claude', 'projects')
let stops = 0
const count = {}
const samples = {}

for (const proj of readdirSync(root)) {
  const d = join(root, proj)
  let files
  try { if (!statSync(d).isDirectory()) continue; files = readdirSync(d).filter(f => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    let lines
    try { const p = join(d, f); if (statSync(p).size > 12e6) continue; lines = readFileSync(p, 'utf8').split('\n') } catch { continue }
    let lastText = null, lastRole = null
    for (const line of lines) {
      if (!line) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      const c = e.message?.content; if (!Array.isArray(c)) continue
      if (e.type === 'assistant') { for (const b of c) if (b.type === 'text' && b.text) lastText = b.text; lastRole = 'assistant' }
      else if (e.type === 'user') {
        if (c.some(b => b.type === 'text') && lastRole === 'assistant' && lastText) {
          stops++
          for (const [k, p] of Object.entries(KINDS)) {
            const hit = NAMES.has(k) ? claimedWhat(lastText, p) : claimed(lastText, p)
            if (hit) {
              count[k] = (count[k] ?? 0) + 1
              ;(samples[k] ??= []).length < 2 && samples[k].push(typeof hit === 'string' ? hit : hit.sentence)
            }
          }
          lastText = null
        }
        lastRole = 'user'
      }
    }
  }
}
console.log(`${stops} stop reali\n`)
for (const k of Object.keys(KINDS)) {
  const n = count[k] ?? 0
  console.log(`  ${k.padEnd(8)} ${String(n).padStart(4)}  ${((100 * n) / stops).toFixed(2)}%`)
  for (const s of samples[k] ?? []) console.log(`           "${s.slice(0, 90)}"`)
}
