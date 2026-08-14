import { describe, expect, it } from 'vitest'
import {
  buildMentionCounts, flattenPath, mentionName, mentionToken, rankRows, rankScore, uniqueCandidates,
} from '../src/client/rank.ts'
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

describe('flattenPath / mentionToken', () => {
  it('flattens separators into the chip-compatible [\\w-]+ shape', () => {
    expect(flattenPath('warning-disposal-report/index.vue')).toBe('warning-disposal-report-index-vue')
    expect(flattenPath('src/util')).toBe('src-util')
    expect(flattenPath('docs')).toBe('docs')
  })

  it('files mention parent/name, directories mention their own name', () => {
    const counts = buildMentionCounts(rows)
    expect(mentionToken(rows[1]!, counts)).toBe('@warning-disposal-report-index-vue')
    expect(mentionToken(rows[0]!, counts)).toBe('@warning-disposal-report')
    expect(mentionName(rows[0]!, counts)).toBe('warning-disposal-report')
  })

  it('extends the suffix while the flattened token collides with another row', () => {
    const deep: RankableRow[] = [
      { type: 'directory', path: 'src/views/kabuto/statistics/warning-disposal-report', name: 'warning-disposal-report', dir: 'src/views/kabuto/statistics' },
      { type: 'file', path: 'src/views/kabuto/statistics/warning-disposal-report/index.vue', name: 'index.vue', dir: 'src/views/kabuto/statistics/warning-disposal-report' },
      { type: 'file', path: 'a/b/x.ts', name: 'x.ts', dir: 'a/b' },
      { type: 'file', path: 'c/b/x.ts', name: 'x.ts', dir: 'c/b' },
      { type: 'directory', path: 'p/q', name: 'q', dir: 'p' },
      { type: 'directory', path: 'r/q', name: 'q', dir: 'r' },
    ]
    const counts = buildMentionCounts(deep)
    // The user's exact expectation: deep file → parent/name form.
    expect(mentionToken(deep[1]!, counts)).toBe('@warning-disposal-report-index-vue')
    expect(mentionToken(deep[0]!, counts)).toBe('@warning-disposal-report')
    // `b/x.ts` collides → extend one segment up.
    expect(mentionToken(deep[2]!, counts)).toBe('@a-b-x-ts')
    expect(mentionToken(deep[3]!, counts)).toBe('@c-b-x-ts')
    // Directory `q` collides → extend.
    expect(mentionToken(deep[4]!, counts)).toBe('@p-q')
    expect(mentionToken(deep[5]!, counts)).toBe('@r-q')
  })
})
