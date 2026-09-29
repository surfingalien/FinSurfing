'use strict'
/**
 * Unit tests for lib/symbol-search.js.
 *
 * The property under test: the best match across ALL providers reaches the
 * user. The old endpoint could not promise that — it returned whichever
 * provider answered first, and each provider had already sliced its own list
 * before anything ranked it.
 */

const {
  scoreQuote, foldQuote, mergeQuotes, fromSymbolDb,
  EXACT_SYMBOL, SYMBOL_PREFIX, NAME_WORD, SYMBOL_INFIX, NAME_INFIX,
  DEFAULT_LIMIT, MAX_LIMIT,
} = require('../lib/symbol-search')

const list = (provider, ...quotes) => ({ provider, quotes })

describe('scoreQuote', () => {
  const q = (symbol, shortname = '') => ({ symbol, shortname })

  test('ranks exact symbol above every other kind of match', () => {
    expect(scoreQuote(q('AAPL'), 'AAPL')).toBe(EXACT_SYMBOL)
    expect(scoreQuote(q('AAPL34'), 'AAPL')).toBe(SYMBOL_PREFIX)
    expect(scoreQuote(q('XAAPLY'), 'AAPL')).toBe(SYMBOL_INFIX)
  })

  test('a name match on a word boundary beats a symbol that merely contains the letters', () => {
    // "Apple Inc" is what someone typing APPLE meant; XAPPLEY is not.
    expect(scoreQuote(q('AAPL', 'Apple Inc'), 'APPLE')).toBe(NAME_WORD)
    expect(scoreQuote(q('XAPPLEY'), 'APPLE')).toBe(SYMBOL_INFIX)
    expect(NAME_WORD).toBeGreaterThan(SYMBOL_INFIX)
  })

  test('a mid-word name match still counts, but lowest', () => {
    expect(scoreQuote(q('SNAP', 'Pineapple Holdings'), 'APPLE')).toBe(NAME_INFIX)
  })

  test('no match and malformed rows score zero', () => {
    expect(scoreQuote(q('MSFT', 'Microsoft'), 'AAPL')).toBe(0)
    expect(scoreQuote({}, 'AAPL')).toBe(0)
    expect(scoreQuote(null, 'AAPL')).toBe(0)
  })

  test('a regex-special query is matched literally, not compiled', () => {
    // The query is arbitrary user input; an unescaped "(" would throw.
    expect(() => scoreQuote(q('BRK.B', 'Berkshire'), 'BRK.B')).not.toThrow()
    expect(() => scoreQuote(q('X', 'a(b'), 'A(B')).not.toThrow()
    expect(scoreQuote(q('BRK.B'), 'BRK.B')).toBe(EXACT_SYMBOL)
    // "." must not act as a wildcard against a name.
    expect(scoreQuote(q('ZZZZ', 'AxBC Corp'), 'A.BC')).toBe(0)
  })
})

describe('foldQuote', () => {
  test('a blank field never overwrites a value the other provider filled', () => {
    const merged = foldQuote(
      { symbol: 'AAPL', shortname: 'Apple', longname: '', quoteType: 'EQUITY', exchange: '', sources: ['finnhub'] },
      { symbol: 'AAPL', shortname: '', longname: 'Apple Inc', quoteType: 'EQUITY', exchange: 'NASDAQ', sources: ['fmp'] },
    )
    expect(merged.shortname).toBe('Apple')     // held, not clobbered by ''
    expect(merged.longname).toBe('Apple Inc')  // filled from the second
    expect(merged.exchange).toBe('NASDAQ')
    expect(merged.sources.sort()).toEqual(['finnhub', 'fmp'])
  })
})

/**
 * The regression case: the behaviour the old cascade could not produce.
 */
describe('mergeQuotes — the bug the cascade caused', () => {
  test('a later provider\'s exact match outranks the first provider\'s noise', () => {
    // Finnhub answers with a Brazilian BDR and an unrelated REIT. Under
    // first-wins that WAS the answer and plain AAPL never appeared.
    const out = mergeQuotes([
      list('finnhub',
        { symbol: 'AAPL34.SA', shortname: 'Apple Inc BDR' },
        { symbol: 'APLE', shortname: 'Apple Hospitality REIT' }),
      list('fmp', { symbol: 'AAPL', shortname: 'Apple Inc', exchange: 'NASDAQ' }),
    ], 'AAPL')

    expect(out[0].symbol).toBe('AAPL')
    expect(out.map(x => x.symbol)).toContain('AAPL34.SA')
  })

  test('a mutual fund only FMP knows about is no longer suppressed by Finnhub', () => {
    // FMP is the repo's only NAV provider for mutual funds, and under the old
    // cascade it was reached only when Finnhub returned literally nothing.
    const out = mergeQuotes([
      list('finnhub', { symbol: 'FXAIXX', shortname: 'Unrelated ticker' }),
      list('fmp', { symbol: 'FXAIX', shortname: 'Fidelity 500 Index Fund', quoteType: 'FUND' }),
    ], 'FXAIX')

    expect(out[0]).toMatchObject({ symbol: 'FXAIX', quoteType: 'FUND' })
  })

  test('the slice happens last, so a match deep in one provider still wins', () => {
    // Each provider used to slice its own list BEFORE ranking, so an exact
    // match at position 11 was gone before anything could promote it.
    const filler = Array.from({ length: 20 }, (_, i) => ({ symbol: `NVDA${i}`, shortname: 'filler' }))
    const out = mergeQuotes([list('finnhub', ...filler, { symbol: 'NVDA', shortname: 'NVIDIA Corp' })], 'NVDA', { limit: 5 })

    expect(out).toHaveLength(5)
    expect(out[0].symbol).toBe('NVDA')
  })
})

describe('mergeQuotes — dedupe and ordering', () => {
  test('one symbol from several providers appears once, with the fields merged', () => {
    const out = mergeQuotes([
      list('finnhub', { symbol: 'MSFT', shortname: 'Microsoft Corp' }),
      list('fmp',     { symbol: 'MSFT', shortname: 'Microsoft Corporation', exchange: 'NASDAQ' }),
      list('symboldb',{ symbol: 'MSFT', shortname: 'Microsoft', quoteType: 'EQUITY' }),
    ], 'MSFT')

    expect(out).toHaveLength(1)
    expect(out[0].exchange).toBe('NASDAQ')
    expect(out[0].sources.sort()).toEqual(['finnhub', 'fmp', 'symboldb'])
  })

  test('the higher-ranked provider owns a field both filled', () => {
    const out = mergeQuotes([
      list('fmp',     { symbol: 'MSFT', shortname: 'FMP name' }),
      list('finnhub', { symbol: 'MSFT', shortname: 'Finnhub name' }),
    ], 'MSFT')
    expect(out[0].shortname).toBe('Finnhub name')
  })

  test('corroboration breaks a tie between equally-scored symbols', () => {
    const out = mergeQuotes([
      list('finnhub', { symbol: 'TSLA1', shortname: 'x' }, { symbol: 'TSLA2', shortname: 'y' }),
      list('fmp',     { symbol: 'TSLA2', shortname: 'y' }),
    ], 'TSLA')
    expect(out[0].symbol).toBe('TSLA2')   // two providers returned it
  })

  test('shorter symbols win when score and corroboration are equal', () => {
    const out = mergeQuotes([list('finnhub',
      { symbol: 'VOOG' }, { symbol: 'VOO' }, { symbol: 'VOOV' })], 'VOO')
    expect(out.map(x => x.symbol)).toEqual(['VOO', 'VOOG', 'VOOV'])
  })

  test('rows that do not match the query at all are dropped', () => {
    const out = mergeQuotes([list('finnhub',
      { symbol: 'AAPL', shortname: 'Apple' }, { symbol: 'XOM', shortname: 'Exxon' })], 'AAPL')
    expect(out.map(x => x.symbol)).toEqual(['AAPL'])
  })
})

describe('mergeQuotes — limits and bad input', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ symbol: `AA${String(i).padStart(3, '0')}` }))

  test('defaults to DEFAULT_LIMIT and clamps to MAX_LIMIT', () => {
    expect(mergeQuotes([list('finnhub', ...many)], 'AA')).toHaveLength(DEFAULT_LIMIT)
    expect(mergeQuotes([list('finnhub', ...many)], 'AA', { limit: 999 })).toHaveLength(MAX_LIMIT)
    expect(mergeQuotes([list('finnhub', ...many)], 'AA', { limit: 0 })).toHaveLength(DEFAULT_LIMIT)
    expect(mergeQuotes([list('finnhub', ...many)], 'AA', { limit: -5 })).toHaveLength(1)
  })

  test('an empty or missing query returns nothing rather than everything', () => {
    expect(mergeQuotes([list('finnhub', { symbol: 'AAPL' })], '')).toEqual([])
    expect(mergeQuotes([list('finnhub', { symbol: 'AAPL' })], null)).toEqual([])
    expect(mergeQuotes([list('finnhub', { symbol: 'AAPL' })], '   ')).toEqual([])
  })

  test('the query is matched case-insensitively', () => {
    expect(mergeQuotes([list('finnhub', { symbol: 'AAPL' })], 'aapl')[0].symbol).toBe('AAPL')
  })

  test('malformed lists and rows are skipped, not thrown on', () => {
    expect(mergeQuotes(null, 'AAPL')).toEqual([])
    expect(mergeQuotes([null, undefined, { provider: 'x' }], 'AAPL')).toEqual([])
    expect(mergeQuotes([list('finnhub', null, {}, { symbol: '' }, { symbol: 'AAPL' })], 'AAPL'))
      .toHaveLength(1)
  })

  test('an unknown provider sorts last rather than being dropped', () => {
    const out = mergeQuotes([
      list('mystery', { symbol: 'AAPL', shortname: 'Mystery name' }),
      list('finnhub', { symbol: 'AAPL', shortname: 'Finnhub name' }),
    ], 'AAPL')
    expect(out).toHaveLength(1)
    expect(out[0].shortname).toBe('Finnhub name')
  })
})

describe('fromSymbolDb', () => {
  test('maps each asset class to the shared quote shape', () => {
    expect(fromSymbolDb([
      { symbol: 'AAPL',    name: 'Apple Inc',   assetClass: 'equity' },
      { symbol: 'VOO',     name: 'Vanguard 500', assetClass: 'etf' },
      { symbol: 'FXAIX',   name: 'Fidelity 500', assetClass: 'fund' },
      { symbol: 'BTC',     name: 'Bitcoin',      assetClass: 'crypto' },
      { symbol: 'WAT',     name: 'Unknown',      assetClass: 'other' },
    ]).map(q => q.quoteType)).toEqual(['EQUITY', 'ETF', 'FUND', 'CRYPTO', 'EQUITY'])
  })

  test('crypto is no longer mislabelled as EQUITY', () => {
    // The old inline fallback mapped crypto → EQUITY, so a coin from the local
    // index arrived at the UI claiming to be a stock.
    expect(fromSymbolDb([{ symbol: 'BTC', name: 'Bitcoin', assetClass: 'crypto' }])[0].quoteType)
      .toBe('CRYPTO')
  })

  test('a non-array is well-formed, not a crash', () => {
    expect(fromSymbolDb(null)).toEqual([])
    expect(fromSymbolDb(undefined)).toEqual([])
  })
})
