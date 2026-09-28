// Of the path findings, how many name a file that NEVER existed in the repo's history
// (a real invention) versus one that merely moved or was deleted since (my sweep's
// own artefact, not the tool's error)?
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { citedPaths } from '../claimcheck.mjs'

const root = join(homedir(), '.claude', 'projects')
const git = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore','pipe','ignore'] }).trim() } catch { return null } }
let everExisted = 0, neverExisted = 0, unknown = 0
const neverSamples = []

for (const proj of readdirSync(root)) {
  const d = join(root, proj)
  let files; try { if (!statSync(d).isDirectory()) continue; files = readdirSync(d).filter(f => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    let lines; try { const p = join(d, f); if (statSync(p).size > 12e6) continue; lines = readFileSync(p, 'utf8').split('\n') } catch { continue }
    let lastText = null, lastRole = null, cwd = null
    for (const line of lines) {
      if (!line) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.cwd && !cwd) cwd = e.cwd
      const c = e.message?.content; if (!Array.isArray(c)) continue
      if (e.type === 'assistant') { for (const b of c) if (b.type === 'text' && b.text) lastText = b.text; lastRole = 'assistant' }
      else if (e.type === 'user') {
        if (c.some(b => b.type === 'text') && lastRole === 'assistant' && lastText && cwd && existsSync(cwd)) {
          for (const [p, { rooted }] of citedPaths(lastText)) {
            if (!rooted || existsSync(join(cwd, p))) continue
            if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') { unknown++; continue }
            const hist = git(cwd, ['log', '--all', '--oneline', '-1', '--', p])
            if (hist === null) unknown++
            else if (hist) everExisted++
            else { neverExisted++; if (neverSamples.length < 10) neverSamples.push(`${p}  (in ${cwd.split('/').slice(-1)[0]})`) }
          }
          lastText = null
        }
        lastRole = 'user'
      }
    }
  }
}
const tot = everExisted + neverExisted + unknown
console.log(`path findings examined   ${tot}`)
console.log(`  existed in git history ${everExisted}   <- moved/deleted since: my sweep's artefact, not a block the tool would have made at the time`)
console.log(`  NEVER in git history   ${neverExisted}   <- a genuinely invented path`)
console.log(`  not a git repo / n.a.  ${unknown}`)
console.log(`\n--- never existed ---`); neverSamples.forEach(s => console.log('  • ' + s))
