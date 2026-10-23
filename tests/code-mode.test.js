'use strict'

// Code mode: Claude answers fan-out questions by writing code that calls our
// read-only data tools. The pure gate (lib/code-mode.js) and the turn loop in
// routes/copilot.js, against a scripted API.

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate, stream: jest.fn() } })))
jest.mock('../lib/alt-data', () => ({
  getAltDataSnippet: jest.fn(async () => null),
  getGeopoliticalRiskSnippet: jest.fn(async () => null),
  getInsiderActivity: jest.fn(async () => [
    { date: '2026-10-01', name: 'J Doe', title: 'CEO', type: 'BUY', qty: 5000 },
    { date: '2026-09-20', name: 'A Roe', title: 'CFO', type: 'SELL', qty: 1000 },
  ]),
  getShortInterest: jest.fn(async () => [{ week: '2026-10-13', shortRatio: 3.2 }]),
}))

const cm = require('../lib/code-mode')
const copilot = require('../routes/copilot')

describe('the gate', () => {
  test('only the read-only data tools become callable from code', () => {
    const callable = copilot.CODE_MODE_TOOLS.filter(t => t.allowed_callers).map(t => t.name).sort()
    expect(callable).toEqual([...cm.CODE_CALLABLE].sort())
    expect(copilot.CODE_MODE_TOOLS[0]).toEqual({ type: cm.CODE_TOOL_VERSION, name: 'code_execution' })
    for (const paid of ['scan_market', 'get_recommendations', 'analyze_symbol', 'propose_strategies', 'critique_risk', 'analyze_filing', 'read_url']) {
      expect(copilot.CODE_MODE_TOOLS.find(t => t.name === paid).allowed_callers).toBeUndefined()
    }
  })

  test('every code-callable tool exists, has a documented JSON shape, and stays directly callable', () => {
    for (const name of cm.CODE_CALLABLE) {
      const t = copilot.CODE_MODE_TOOLS.find(x => x.name === name)
      expect(t).toBeDefined()
      expect(copilot.CODE_SHAPES[name]).toBeTruthy()
      expect(t.description).toContain('When called from code it returns a JSON string')
      expect(t.allowed_callers).toEqual(['direct', cm.CODE_TOOL_VERSION])
    }
  })

  test('a non-listed tool is refused from code even if the API forwards it, and the budget is enforced', () => {
    const b = cm.newBudget(2)
    expect(cm.admitCall('scan_market', b)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be called from code/) })
    expect(cm.admitCall('get_fundamentals', b).ok).toBe(true)
    expect(cm.admitCall('get_fundamentals', b).ok).toBe(true)
    expect(cm.admitCall('get_fundamentals', b)).toMatchObject({ ok: false, error: expect.stringMatching(/budget/) })
  })

  test('fan-out questions use code mode; single-symbol questions keep the streamed loop', () => {
    expect(cm.wantsCodeMode('which tech names in the sector list have insider buying and P/E under 25')).toBe(true)
    expect(cm.wantsCodeMode("map SpaceX's exposure, then check analyst views on each name")).toBe(true)
    expect(cm.wantsCodeMode('NVDA AMD AVGO — who has the best margins?')).toBe(true)
    expect(cm.wantsCodeMode("what's NVDA's RSI right now?")).toBe(false)
    expect(cm.wantsCodeMode('explain the macro regime')).toBe(false)
  })

  test('an API refusal that names code execution latches it off; an outage does not', () => {
    cm._resetForTests()
    expect(cm.noteRefusal(Object.assign(new Error('overloaded'), { status: 529 }))).toBe(false)
    expect(cm.codeModeEnabled({})).toBe(true)
    expect(cm.noteRefusal(Object.assign(new Error('tools.0: code_execution_20260521 is not available for this organization'), { status: 400 }))).toBe(true)
    expect(cm.codeModeEnabled({})).toBe(false)
    cm._resetForTests()
    expect(cm.codeModeEnabled({ COPILOT_CODE_MODE: 'off' })).toBe(false)
  })
})

describe('runCodeModeTurn', () => {
  const req = { headers: {}, body: {} }
  let realFetch
  beforeEach(() => { mockCreate.mockReset(); cm._resetForTests(); realFetch = global.fetch; global.fetch = jest.fn(async () => { throw new Error('no network in tests') }) })
  afterEach(() => { global.fetch = realFetch })

  test('serves calls from code with JSON, refuses a paid tool, resumes in the same container with tool results only', async () => {
    const caller = { type: 'code_execution_20260120', tool_id: 'srvtoolu_1' }
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Screening the sector.' },
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: { code: '...' } },
          { type: 'tool_use', id: 'toolu_a', name: 'get_insider_activity', input: { symbol: 'nvda' }, caller },
          { type: 'tool_use', id: 'toolu_b', name: 'scan_market', input: {}, caller },
        ],
        container: { id: 'container_1', expires_at: '2026-10-23T21:00:00Z' },
        stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 },
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'code_execution_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'code_execution_result', stdout: 'NVDA buying', stderr: '', return_code: 0, content: [] } },
          { type: 'text', text: 'NVDA shows net insider buying.' },
        ],
        container: { id: 'container_1' }, stop_reason: 'end_turn', usage: { input_tokens: 80, output_tokens: 20 },
      })

    const events = []
    const handled = await copilot._runCodeModeTurnForTests({ model: 'claude-sonnet-4-6', contextBlock: '', messages: [{ role: 'user', content: 'which tech names have insider buying' }], send: e => events.push(e), req })
    expect(handled).toBe(true)

    const second = mockCreate.mock.calls[1][0]
    expect(second.container).toBe('container_1')
    expect(second.tools).toBe(copilot.CODE_MODE_TOOLS)
    // the paused assistant content goes back verbatim
    expect(second.messages[1].content[1]).toEqual({ type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: { code: '...' } })
    const reply = second.messages.at(-1)
    expect(reply.role).toBe('user')
    expect(reply.content.every(b => b.type === 'tool_result' && !b.cache_control)).toBe(true)

    const insider = JSON.parse(reply.content.find(b => b.tool_use_id === 'toolu_a').content)
    expect(insider).toMatchObject({ symbol: 'NVDA', buys: 1, sells: 1, buyShares: 5000, sellShares: 1000, net: 'buying', shortRatioPct: 3.2 })
    const scan = reply.content.find(b => b.tool_use_id === 'toolu_b')
    expect(scan.is_error).toBe(true)
    expect(JSON.parse(scan.content).error).toMatch(/cannot be called from code/)
    expect(global.fetch).not.toHaveBeenCalled()          // the scan never ran

    expect(events.filter(e => e.type === 'text').map(e => e.delta)).toEqual(['Screening the sector.', 'NVDA shows net insider buying.'])
    expect(events.find(e => e.type === 'tool_start').tools.map(t => t.name)).toEqual(['code_execution', 'get_insider_activity', 'scan_market'])
  })

  test('a refusal before anything was sent hands the turn back to the classic loop', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('code_execution is not supported on this model'), { status: 400 }))
    const events = []
    const handled = await copilot._runCodeModeTurnForTests({ model: 'm', contextBlock: '', messages: [{ role: 'user', content: 'screen the sector' }], send: e => events.push(e), req })
    expect(handled).toBe(false)
    expect(events).toEqual([])
    expect(cm.codeModeEnabled({})).toBe(false)
    console.warn.mockRestore()
  })

  test('the stored exposure map is read, never rebuilt, from code', async () => {
    global.fetch = jest.fn(async url => ({ ok: true, json: async () => ({ edges: [{ symbol: 'RKLB', relation: 'supplier', score: 61, materialityPct: 12, evidence: { form: '10-K', filedAt: '2026-02-01', quote: 'untrusted filing text' } }], universe: ['RKLB'] }) }))
    const out = await copilot.dispatchToolData('find_exposure', { anchor: 'spacex', refresh: true }, req)
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/exposure\/SPACEX\/graph$/)
    expect(out.edges[0]).toEqual({ symbol: 'RKLB', relation: 'supplier', score: 61, materialityPct: 12, form: '10-K', filedAt: '2026-02-01' })
    expect(JSON.stringify(out)).not.toContain('untrusted filing text')
  })
})

test('code mode hands every served result and the program output to the answer audit', async () => {
  const caller = { type: 'code_execution_20260120', tool_id: 'srvtoolu_9' }
  mockCreate.mockReset()
  mockCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't1', name: 'get_insider_activity', input: { symbol: 'AMD' }, caller }], container: { id: 'c9' }, stop_reason: 'tool_use', usage: {} })
    .mockResolvedValueOnce({ content: [{ type: 'code_execution_tool_result', tool_use_id: 'srvtoolu_9', content: { stdout: 'AMD net buying 5000 shares' } }, { type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} })
  const evidence = []
  await copilot._runCodeModeTurnForTests({ model: 'm', contextBlock: '', messages: [{ role: 'user', content: 'which names have insider buying' }], send: () => {}, req: { headers: {}, body: {} }, onEvidence: e => evidence.push(e) })
  expect(evidence.some(e => /"buyShares":5000/.test(e))).toBe(true)
  expect(evidence).toContain('AMD net buying 5000 shares')
})
