'use strict'
/**
 * Unit tests for lib/compress.js — prose compaction for AI prompt context.
 * Verifies it shrinks boilerplate while preserving all word/number content.
 */

const { compactProse, compactWhitespace } = require('../lib/compress')

describe('compactProse', () => {
  test('collapses whitespace and blank-line runs', () => {
    const out = compactProse('Revenue   grew.\n\n\n\nMargins  held.')
    expect(out).toBe('Revenue grew.\n\nMargins held.')
  })

  test('drops separator, page-marker and bare page-number lines', () => {
    const input = [
      'Item 1A. Risk Factors',
      '----------------------',
      'Page 12 of 80',
      '12',
      'Supply chain risk is material.',
    ].join('\n')
    const out = compactProse(input)
    expect(out).toContain('Item 1A. Risk Factors')
    expect(out).toContain('Supply chain risk is material.')
    expect(out).not.toMatch(/----/)
    expect(out).not.toMatch(/Page 12 of 80/)
    expect(out.split('\n')).not.toContain('12')
  })

  test('removes Table of Contents / boilerplate lines', () => {
    const out = compactProse('Table of Contents\nReal content here.\n(continued)')
    expect(out).toBe('Real content here.')
  })

  test('drops immediately repeated lines', () => {
    const out = compactProse('Same line\nSame line\nDifferent')
    expect(out).toBe('Same line\nDifferent')
  })

  test('PRESERVES numbers, currency, percentages and tickers exactly', () => {
    const input = 'NVDA revenue was $26,044 million, up 262% YoY. Q2 2024 EPS $0.68.'
    expect(compactProse(input)).toBe(input)
  })

  test('keeps a standalone 4-digit number (could be a year/figure)', () => {
    const out = compactProse('Outlook\n2024\nGuidance raised.')
    expect(out.split('\n')).toContain('2024')
  })

  test('actually reduces length on boilerplate-heavy input', () => {
    const input = 'A\n\n\n\n=========\nPage 1\n1\nB\nB\n\n\n'
    const out = compactProse(input)
    expect(out.length).toBeLessThan(input.length)
    expect(out).toBe('A\n\nB')
  })

  test('empty / null input → empty string', () => {
    expect(compactProse('')).toBe('')
    expect(compactProse(null)).toBe('')
  })
})

describe('compactWhitespace', () => {
  test('collapses spaces and excess blank lines without dropping lines', () => {
    expect(compactWhitespace('a   b\n\n\n\nc')).toBe('a b\n\nc')
  })

  test('preserves content and numbers', () => {
    expect(compactWhitespace('Price:  $1,234.56')).toBe('Price: $1,234.56')
  })

  test('empty → empty', () => {
    expect(compactWhitespace('')).toBe('')
  })
})
