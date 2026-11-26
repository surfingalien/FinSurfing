'use strict'
const { paramSurface } = require('../lib/param-surface')

const grid = fn => {
  const out = []
  for (let a = 5; a <= 25; a += 5) for (let b = 50; b <= 150; b += 25) out.push({ params: { fastPeriod: a, slowPeriod: b }, metrics: { sharpeRatio: fn(a, b) } })
  return out
}

describe('paramSurface', () => {
  it('lays the grid out and finds the best cell', () => {
    const s = paramSurface(grid((a, b) => a / 10 + b / 100))
    expect(s.kind).toBe('grid')
    expect(s.x.values).toEqual([5, 10, 15, 20, 25])
    expect(s.y.values).toEqual([50, 75, 100, 125, 150])
    expect(s.best).toMatchObject({ x: 25, y: 150 })
    expect(s.cells[4][4]).toBe(4)
  })
  it('a broad good area is a plateau', () => {
    expect(paramSurface(grid((a, b) => 1 + (a === 15 && b === 100 ? 0.3 : 0))).shape).toBe('plateau')
  })
  it('one bright cell among poor neighbours is a spike', () => {
    expect(paramSurface(grid((a, b) => (a === 15 && b === 100 ? 2 : -0.2))).shape).toBe('spike')
  })
  it('needs exactly two varied parameters, and says why otherwise', () => {
    const one = [5, 10, 15].map(a => ({ params: { fastPeriod: a, slowPeriod: 50 }, metrics: { sharpeRatio: a } }))
    expect(paramSurface(one)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/vary two/) })
    expect(paramSurface([])).toMatchObject({ kind: 'none' })
  })
})
