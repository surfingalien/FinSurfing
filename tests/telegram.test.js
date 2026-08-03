'use strict'
/**
 * Unit tests for the Telegram gateway: notifier formatters, command parsing,
 * and the brain-learnings white-box override merge. No network — send() and
 * getUpdates() are thin fetch wrappers; the logic worth testing is pure.
 */

const notify = require('../lib/telegram-notify')
const bot    = require('../lib/telegram-bot')

describe('telegram-notify formatters', () => {
  test('formatAnalysis renders symbol, signal emoji, and confidence', () => {
    const m = notify.formatAnalysis({
      type: 'analysis', symbol: 'AAPL', signal: 'BUY', confidence: 0.82,
      entry: '190', stopLoss: '180', triggeredBy: { type: 'price_above', threshold: '195' },
      reasoning: 'strong setup',
    })
    expect(m).toContain('AAPL BUY')
    expect(m).toContain('🟢')
    expect(m).toContain('conf 82%')
    expect(m).toContain('triggered by price_above')
  })

  test('sell shows the red marker; unknown falls back to neutral', () => {
    expect(notify.formatAnalysis({ symbol: 'X', signal: 'SELL' })).toContain('🔴')
    expect(notify.formatAnalysis({ symbol: 'X', signal: 'HOLD' })).toContain('🟡')
  })

  test('HTML is escaped so a crafted field cannot inject markup', () => {
    expect(notify.escapeHtml('<b>&x</b>')).toBe('&lt;b&gt;&amp;x&lt;/b&gt;')
  })

  test('alerts are not configured without a token/chat', () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN
    const savedChat = process.env.TELEGRAM_CHAT_ID
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
    expect(notify.alertsConfigured()).toBe(false)
    if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken
    if (savedChat !== undefined) process.env.TELEGRAM_CHAT_ID = savedChat
  })
})

describe('telegram-bot command parsing', () => {
  test('plain command', () => {
    expect(bot.parseCommand('/status')).toEqual({ cmd: 'status', args: [] })
  })
  test('group @BotName form and args', () => {
    expect(bot.parseCommand('/status@FinSurfBot')).toEqual({ cmd: 'status', args: [] })
    expect(bot.parseCommand('/learnings extra')).toEqual({ cmd: 'learnings', args: ['extra'] })
  })
  test('case-insensitive verb; non-commands are null', () => {
    expect(bot.parseCommand('/STATUS').cmd).toBe('status')
    expect(bot.parseCommand('hello')).toBeNull()
    expect(bot.parseCommand('')).toBeNull()
    expect(bot.parseCommand(null)).toBeNull()
  })
})

describe('telegram-bot authorization', () => {
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID }
  let sendSpy

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_CHAT_ID   = '12345'
    bot._resetForTests()
    sendSpy = jest.spyOn(notify, 'send').mockResolvedValue(true)
  })
  afterEach(() => {
    sendSpy.mockRestore()
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = saved.token
    if (saved.chat  === undefined) delete process.env.TELEGRAM_CHAT_ID;   else process.env.TELEGRAM_CHAT_ID   = saved.chat
  })

  const msg = (chatId, text) => ({ message: { chat: { id: chatId }, text } })

  test('an unauthorized chat gets NO reply — the bot must not be a free send trigger', async () => {
    await bot.processUpdate(msg(99999, '/status'))
    expect(sendSpy).not.toHaveBeenCalled()
  })

  test('repeated probing from a stranger still sends nothing', async () => {
    for (let i = 0; i < 5; i++) await bot.processUpdate(msg(99999, '/status'))
    expect(sendSpy).not.toHaveBeenCalled()
  })

  test('the authorized chat is answered', async () => {
    await bot.processUpdate(msg(12345, '/help'))
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][0]).toContain('FinSurf bot')
  })

  test('non-command messages are ignored even from the authorized chat', async () => {
    await bot.processUpdate(msg(12345, 'just chatting'))
    expect(sendSpy).not.toHaveBeenCalled()
  })
})

describe('brain-learnings white-box overrides', () => {
  const bl = require('../lib/brain-learnings')

  test('applyOverrides drops suppressed (case-insensitive) and appends pinned', () => {
    const base = ['Volume confirms alpha', 'Earnings windows risky', 'Macro matters']
    const out = bl.applyOverrides(base, { suppressed: ['EARNINGS windows risky'], pinned: ['Trust RS rank'] })
    expect(out).toContain('Volume confirms alpha')
    expect(out.some(l => l.toLowerCase().includes('earnings windows'))).toBe(false)
    expect(out).toContain('Trust RS rank [pinned]')
    expect(out).toHaveLength(3) // 3 base - 1 suppressed + 1 pinned
  })

  test('empty overrides are a pass-through', () => {
    const base = ['a', 'b']
    expect(bl.applyOverrides(base, { pinned: [], suppressed: [] })).toEqual(['a', 'b'])
  })

  // The injected prompt must never let a human opinion inherit the authority
  // of a measured finding — that is the confusion the calibration loop exists
  // to prevent. Measured and human-authored content live in separate sections.
  test('getLearningsBlock separates measured findings from operator guidance', () => {
    const fs = require('fs'), path = require('path')
    const LEARNINGS = path.join(__dirname, '../data/brain-learnings.json')
    const beforeL = fs.existsSync(LEARNINGS) ? fs.readFileSync(LEARNINGS) : null
    const beforeO = fs.existsSync(bl.OVERRIDES_FILE) ? fs.readFileSync(bl.OVERRIDES_FILE) : null
    try {
      fs.mkdirSync(path.dirname(LEARNINGS), { recursive: true })
      fs.writeFileSync(LEARNINGS, JSON.stringify({
        updatedAt: new Date().toISOString(),
        totalResolved: 12,
        keyLearnings: ['Measured finding A', 'Stale finding B'],
        scoreWeightAdjustments: {},
      }))
      bl.writeOverrides({ pinned: ['My own hunch'], suppressed: ['Stale finding B'], note: 'Be cautious on small caps' })

      const block = bl.getLearningsBlock()
      const measuredIdx = block.indexOf('KEY LEARNINGS FROM PAST PREDICTIONS')
      const humanIdx    = block.indexOf('OPERATOR GUIDANCE')

      expect(measuredIdx).toBeGreaterThan(-1)
      expect(humanIdx).toBeGreaterThan(measuredIdx)          // separate, later section
      expect(block).toContain('human-authored')
      expect(block).toContain('NOT measured')
      expect(block).toContain('My own hunch')
      expect(block).toContain('Be cautious on small caps')
      expect(block).not.toContain('Stale finding B')          // suppression still works

      // The human pin must NOT appear inside the measured section
      const measuredSection = block.slice(measuredIdx, humanIdx)
      expect(measuredSection).toContain('Measured finding A')
      expect(measuredSection).not.toContain('My own hunch')
    } finally {
      if (beforeL === null) { try { fs.unlinkSync(LEARNINGS) } catch {} } else fs.writeFileSync(LEARNINGS, beforeL)
      if (beforeO === null) { try { fs.unlinkSync(bl.OVERRIDES_FILE) } catch {} } else fs.writeFileSync(bl.OVERRIDES_FILE, beforeO)
    }
  })

  test('readOverrides returns the empty shape when no file exists', () => {
    const o = bl.readOverrides()
    expect(Array.isArray(o.pinned)).toBe(true)
    expect(Array.isArray(o.suppressed)).toBe(true)
    expect(typeof o.note).toBe('string')
  })

  test('writeOverrides round-trips and clamps oversized input', () => {
    const os = require('os'), path = require('path'), fs = require('fs')
    // Point the module's data dir at a temp copy by exercising the real file
    // path; clean up after so we don't leave override state in the repo.
    const before = fs.existsSync(bl.OVERRIDES_FILE) ? fs.readFileSync(bl.OVERRIDES_FILE) : null
    try {
      const saved = bl.writeOverrides({ pinned: ['keep this'], suppressed: [], note: 'x'.repeat(600) })
      expect(saved.pinned).toEqual(['keep this'])
      expect(saved.note.length).toBe(500) // clamped
      expect(bl.readOverrides().pinned).toEqual(['keep this'])
    } finally {
      if (before === null) { try { fs.unlinkSync(bl.OVERRIDES_FILE) } catch {} }
      else fs.writeFileSync(bl.OVERRIDES_FILE, before)
    }
  })
})
