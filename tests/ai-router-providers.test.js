'use strict'
/**
 * Tests for the OpenAI-compatible provider registry in lib/ai-router.js —
 * Groq / Z.ai (GLM) / Qwen selection and configuration detection. Pure config
 * logic; no network.
 */

const { OPENAI_COMPAT, fallbackProviderName, compatConfigured } = require('../lib/ai-router')

const ORIG = {
  AI_FALLBACK_PROVIDER: process.env.AI_FALLBACK_PROVIDER,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  ZAI_API_KEY: process.env.ZAI_API_KEY,
  QWEN_API_KEY: process.env.QWEN_API_KEY,
  ZAI_MODEL: process.env.ZAI_MODEL,
}
afterEach(() => {
  for (const k of Object.keys(ORIG)) {
    if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k]
  }
})

describe('OPENAI_COMPAT registry', () => {
  test('has groq, zai and qwen with fixed (non-client) base URLs', () => {
    expect(OPENAI_COMPAT.groq.url).toMatch(/groq\.com/)
    expect(OPENAI_COMPAT.zai.url).toMatch(/z\.ai/)
    expect(OPENAI_COMPAT.qwen.url).toMatch(/dashscope/)
  })

  test('model names are env-overridable', () => {
    delete process.env.ZAI_MODEL
    expect(OPENAI_COMPAT.zai.model()).toBe('glm-4.6')
    process.env.ZAI_MODEL = 'glm-5.1'
    expect(OPENAI_COMPAT.zai.model()).toBe('glm-5.1')
  })
})

describe('fallbackProviderName', () => {
  test('defaults to groq when unset or invalid', () => {
    delete process.env.AI_FALLBACK_PROVIDER
    expect(fallbackProviderName()).toBe('groq')
    process.env.AI_FALLBACK_PROVIDER = 'nonsense'
    expect(fallbackProviderName()).toBe('groq')
  })

  test('honors a valid provider name (case-insensitive)', () => {
    process.env.AI_FALLBACK_PROVIDER = 'ZAI'
    expect(fallbackProviderName()).toBe('zai')
    process.env.AI_FALLBACK_PROVIDER = 'qwen'
    expect(fallbackProviderName()).toBe('qwen')
  })
})

describe('compatConfigured', () => {
  test('true only when the provider key env is set', () => {
    delete process.env.ZAI_API_KEY
    expect(compatConfigured('zai')).toBe(false)
    process.env.ZAI_API_KEY = 'sk-test'
    expect(compatConfigured('zai')).toBe(true)
  })

  test('false for unknown providers', () => {
    expect(compatConfigured('bogus')).toBe(false)
  })
})
