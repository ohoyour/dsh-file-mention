import { describe, expect, it } from 'vitest'
import { rankRows, rankScore, shortForm, uniqueCandidates } from '../src/client/rank.ts'
import type { RankableRow } from '../src/client/rank.ts'

const rows: RankableRow[] = [
  { type: 'directory', path: 'warning-disposal-report', name: 'warning-disposal-report', dir: '' },
  { type: 'file', path: 'warning-disposal-report/index.vue', name: 'index.vue', dir: 'warning-disposal-report' },
  { type: 'file', path: 'docs/readme.md', name: 'readme.md', dir: 'docs' },
  { type: 'file', path: 'other/readme.md', name: 'readme.md', dir: 'other' },
]

describe('rankScore / rankRows', () => {
  it('ranks a directory slash query at the top', () => {
    expect(rankScore(rows[0]!, 'warning-disposal-report/')).toBe(0)
    expect(rankRows(rows, 'warning').map(row => row.path)).toEqual([
      'warning-disposal-report',
      'warning-disposal-report/index.vue',
    ])
  })

  it('filters and caps', () => {
    expect(rankRows(rows, 'readme', 1).map(row => row.path)).toEqual(['docs/readme.md'])
  })
})

describe('uniqueCandidates', () => {
  it('renders files with 📄 and directories with 📁 and a trailing slash', () => {
    const candidates = uniqueCandidates([rows[0]!, rows[1]!])
    expect(candidates).toEqual([
      { name: 'warning-disposal-report/', description: undefined, icon: '📁', row: rows[0] },
      { name: 'index.vue', description: 'warning-disposal-report', icon: '📄', row: rows[1] },
    ])
  })

  it('disambiguates clashing basenames with their parent directory', () => {
    const candidates = uniqueCandidates([rows[2]!, rows[3]!])
    expect(candidates.map(candidate => candidate.name)).toEqual(['docs/readme.md', 'other/readme.md'])
    expect(candidates[0]!.row).toBe(rows[2])
  })
})

describe('shortForm', () => {
  it('builds `parent/name` for files and `parent/name/` for directories', () => {
    expect(shortForm(rows[1]!)).toBe('warning-disposal-report/index.vue')
    expect(shortForm(rows[0]!)).toBe('warning-disposal-report/')
  })

  it('keeps workspace-root entries bare', () => {
    expect(shortForm({ type: 'file', path: 'main.ts', name: 'main.ts', dir: '' })).toBe('main.ts')
  })
})
