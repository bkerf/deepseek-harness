import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId, ServiceTierId } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

const model = (slug = 'gpt-6.1-sol', visibility = 'list', multiAgentReasoningEffort: string | null = 'xhigh') => ({
  slug, display_name: slug, description: 'Account model', visibility,
  supported_in_api: false, default_reasoning_level: 'low',
  supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: effort })),
  multi_agent_version: 'v2', multi_agent_reasoning_effort: multiAgentReasoningEffort,
  service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }],
  default_service_tier: null, input_modalities: ['text', 'image'], context_window: 500000,
})
const body = (models = [model()]) => JSON.stringify({ models })
const token = (account = 'harness-account') => `e30.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: account },
})).toString('base64url')}.fixture`

function adapter(baseURL: string, key: () => string | undefined = token, reasoning?: 'high' | 'minimal') {
  const profiles = resolveProfiles({ 'openai-codex': { baseURL, apiKeyEnv: 'CODEX_TEST_KEY', transport: 'sse', ...reasoning === undefined ? {} : { reasoning } } })
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve(key()), auth: memoryAuth() })
}

describe('the Harness account-specific Codex model catalog', () => {
  it('shares discovery, exact capabilities and visible models from one authenticated request', async () => {
    const server = await mockServer([{ body: body([model(), model('hidden', 'hide'), { ...model('future-account-model'), context_window: null }]) }])
    const subject = adapter(server.url)
    const [listed, info] = await Promise.all([
      subject.listModels('openai-codex'), subject.resolveModel('openai-codex', 'gpt-6.1-sol'),
    ])
    expect(listed.map(item => item.id)).toEqual(['gpt-6.1-sol', 'future-account-model'])
    expect(info.context?.contextWindow).toBe(500000)
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    const ultra = info.reasoning?.efforts.find(effort => effort.id === 'ultra')
    expect(ultra?.description).toBe('ultra')
    expect(ultra?.instructions).toContain('subagent or subagent_fork')
    expect(ultra?.instructions).toContain('Wait for the delegated results, integrate them, and verify')
    expect(ultra?.instructions).toContain('configured delegation depth')
    expect(info.reasoning?.efforts.find(effort => effort.id === 'max')?.instructions).toBeUndefined()
    expect(info.reasoning?.defaultEffort).toBe('low')
    expect(info.serviceTiers).toEqual({
      tiers: [{ id: 'default', name: 'Standard' }, { id: 'priority', name: 'Fast', description: '2x speed' }], defaultTier: 'default',
    })
    await expect(subject.resolveModel('openai-codex', 'hidden')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect((await subject.discoverCodexModels()).map(item => item.id)).toEqual(['gpt-6.1-sol', 'future-account-model'])
    expect((await subject.resolveModel('openai-codex', 'future-account-model')).context?.contextWindow).toBe(262144)
    expect(() => subject.imageRequestTarget('openai-codex', 'future-account-model', {
      attachmentId: 'sha256:fixture' as never, mediaType: 'image/png', width: 1, height: 1, bytes: 1,
    })).not.toThrow()
    expect(server.paths).toEqual(['/codex/models?client_version=0.162.0'])
    expect(server.headers[0]).toMatchObject({ authorization: `Bearer ${token()}`, 'chatgpt-account-id': 'harness-account' })
  })

  it('resolves Ultra per model while keeping Max and Fast independent', async () => {
    const server = await mockServer([
      { body: body([model(), model('gpt-6-sol', 'list', null)]) },
      ...Array.from({ length: 5 }, () => ({ status: 401, body: '{}' })),
    ])
    const subject = adapter(server.url, token, 'high')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['openai-codex'], subject)
    try {
      expect((await subject.resolveModel('openai-codex', 'gpt-6.1-sol')).reasoning?.defaultEffort).toBe('high')
      await assemble(ctx, { provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [], reasoningEffort: ReasoningEffortId('ultra'), serviceTier: ServiceTierId('priority') })
      await assemble(ctx, { provider: 'openai-codex', model: 'gpt-6-sol', messages: [], reasoningEffort: ReasoningEffortId('ultra'), serviceTier: ServiceTierId('default') })
      await assemble(ctx, { provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [], reasoningEffort: ReasoningEffortId('max'), serviceTier: ServiceTierId('priority') })
      await assemble(ctx, { provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [], reasoningEffort: ReasoningEffortId('max'), serviceTier: ServiceTierId('default') })
      await assemble(ctx, { provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [] })
      expect(server.requests[1]).toMatchObject({ reasoning: { effort: 'xhigh' }, service_tier: 'priority' })
      expect(server.requests[2]).toMatchObject({ reasoning: { effort: 'max' }, service_tier: 'default' })
      expect(server.requests[3]).toMatchObject({ reasoning: { effort: 'max' }, service_tier: 'priority' })
      expect(server.requests[4]).toMatchObject({ reasoning: { effort: 'max' }, service_tier: 'default' })
      expect(server.requests[5]).toMatchObject({ reasoning: { effort: 'high' } })
      expect(server.requests[5]).not.toHaveProperty('service_tier')
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses efforts and service tiers absent from the account catalog before generation', async () => {
    const server = await mockServer([{ body: body() }])
    const subject = adapter(server.url, token, 'minimal')
    expect((await subject.resolveModel('openai-codex', 'gpt-6.1-sol')).reasoning).not.toHaveProperty('defaultEffort')
    for (const options of [
      { reasoningEffort: ReasoningEffortId('minimal') },
      { reasoningEffort: ReasoningEffortId('high'), serviceTier: ServiceTierId('unavailable') },
    ]) {
      const collect = async () => { for await (const _chunk of subject.stream({ provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [], ...options })) {} }
      await expect(collect()).rejects.toThrow(/does not support/)
    }
    expect(server.paths).toHaveLength(1)
  })

  it('offers no static subscription models before the Harness account is signed in', async () => {
    const subject = adapter('https://example.invalid', () => undefined)
    expect(await subject.listModels('openai-codex')).toEqual([])
    expect(await subject.discoverCodexModels()).toEqual([])
    await expect(subject.resolveModel('openai-codex', 'gpt-6.1-sol')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('allows an explicit later reload after a failed catalog request', async () => {
    const server = await mockServer([{ status: 503, body: '{}' }, { body: body() }])
    const subject = adapter(server.url)
    await expect(subject.listModels('openai-codex')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect((await subject.listModels('openai-codex')).map(item => item.id)).toEqual(['gpt-6.1-sol'])
    expect(server.paths).toHaveLength(2)
  })

  it('does not reuse another Harness account catalog after its credential changes', async () => {
    const server = await mockServer([{ body: body() }, { body: body([model('other-account-model')]) }])
    let access = token()
    const subject = adapter(server.url, () => access)
    await subject.listModels('openai-codex')
    access = token('second-harness-account')
    expect((await subject.listModels('openai-codex')).map(item => item.id)).toEqual(['other-account-model'])
    expect(server.headers[1]).toHaveProperty('chatgpt-account-id', 'second-harness-account')
  })

  it('reports malformed account credentials without putting their value in an error', async () => {
    const subject = adapter('https://example.invalid', () => 'private-invalid-token')
    await expect(subject.listModels('openai-codex')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL', message: 'Codex credential has no account identity' })
  })

  it('reports an invalid stored provider profile instead of discovering with no provider', async () => {
    const subject = new PiAiAdapter({
      profiles: () => resolveProfiles({ 'openai-codex': { api: 'removed-protocol' } }, 'deferred'),
      resolveApiKey: () => Promise.resolve(token()), auth: memoryAuth(),
    })
    await expect(subject.discoverCodexModels()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('keeps an explicitly repointed Codex route on its configured protocol with an opaque API key', async () => {
    const server = await mockServer([{ events: textEvents }])
    const profiles = resolveProfiles({ 'openai-codex': {
      api: 'openai-completions', baseURL: server.url, apiKeyEnv: 'CODEX_GATEWAY_KEY',
    } })
    const subject = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: () => Promise.resolve('opaque-gateway-key'), auth: memoryAuth(),
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['openai-codex'], subject)
    try {
      expect((await subject.listModels('openai-codex')).some(item => item.id === 'gpt-6.1-sol')).toBe(true)
      const result = await assemble(ctx, { provider: 'openai-codex', model: 'gpt-6.1-sol', messages: [] })
      expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
      expect(server.paths).toEqual(['/chat/completions'])
      expect(server.headers[0]).toHaveProperty('authorization', 'Bearer opaque-gateway-key')
    } finally { await ctx.fiber.dispose() }
  })
})
