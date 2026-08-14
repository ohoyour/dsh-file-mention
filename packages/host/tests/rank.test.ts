import { describe, expect, it } from 'vitest'
import { rankRows, rankScore, normalizeQuery } from '../src/rank.ts'
import type { RankableRow } from '../src/rank.ts'

const rows: RankableRow[] = [
  { type: 'directory', path: 'warning-disposal-report', name: 'warning-disposal-report', dir: '' },
  { type: 'file', path: 'warning-disposal-report/index.vue', name: 'index.vue', dir: 'warning-disposal-report' },
  { type: 'file', path: 'warning-disposal-report/data.csv', name: 'data.csv', dir: 'warning-disposal-report' },
  { type: 'file', path: 'src/main.ts', name: 'main.ts', dir: 'src' },
  { type: 'file', path: 'src/util/helper.ts', name: 'helper.ts', dir: 'src/util' },
]

describe('normalizeQuery', () => {
  it('lowercases and converts backslashes', () => {
    expect(normalizeQuery('SRC\\Util')).toBe('src/util')
  })
})

describe('rankScore', () => {
  it('scores base equality highest', () => {
    expect(rankScore(rows[1]!, 'index.vue')).toBe(0)
  })

  it('scores directory base with a trailing slash against a slash query', () => {
    expect(rankScore(rows[0]!, 'warning-disposal-report/')).toBe(0)
    expect(rankScore(rows[0]!, 'warning')).toBe(1)
  })

  it('falls back to path prefix then inclusion', () => {
    expect(rankScore(rows[2]!, 'warning-disposal')).toBe(2)
    expect(rankScore(rows[4]!, 'util/help')).toBe(3)
  })

  it('rejects non-matching rows', () => {
    expect(rankScore(rows[3]!, 'zzz')).toBeUndefined()
  })
})

describe('rankRows', () => {
  it('orders by rank then path length and caps the result', () => {
    const picked = rankRows(rows, 'warning')
    expect(picked.map(row => row.path)).toEqual([
      'warning-disposal-report',
      'warning-disposal-report/data.csv',
      'warning-disposal-report/index.vue',
    ])
  })

  it('returns everything for an empty query', () => {
    expect(rankRows(rows, '', 100)).toHaveLength(rows.length)
  })

  it('respects the limit', () => {
    expect(rankRows(rows, '', 2)).toHaveLength(2)
  })
})
