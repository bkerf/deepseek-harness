import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { type AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf, type PeerId, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import CredentialsController from '../src/credentials.ts'
import type { ProviderAuthorizationAnswer, ProviderAuthorizationFrame } from '../src/types.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture(run: AuthorizationFlow['run']) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(CredentialsController)
  ctx.authorization.registerFlow({ key: KEY, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }], run })
  return ctx
}

function inputChannel() {
  let controller: ReadableStreamDefaultController<ProviderAuthorizationAnswer>
  const stream = new ReadableStream<ProviderAuthorizationAnswer>({ start(value) { controller = value } })
  const reader = stream.getReader()
  const source: AsyncIterable<ProviderAuthorizationAnswer> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const result = await reader.read()
        return result.done ? { done: true, value: undefined } : { done: false, value: result.value }
      },
      async return() { await reader.cancel(); return { done: true, value: undefined } },
    }),
  }
  return { source, send: (answer: ProviderAuthorizationAnswer) => { controller.enqueue(answer) } }
}

function open(ctx: Context, input: AsyncIterable<ProviderAuthorizationAnswer>, signal: AbortSignal) {
  const invocation: RemoteInvocation = {
    request: { namespace: 'credentials', method: 'authorize', args: {} }, service: 'credentialsController', signal,
    peer: { id: 'provider-test-peer' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal, dispose: async () => {} },
    uplink: <In>() => input as AsyncIterable<In>,
    uplinkWindow: undefined,
  }
  return ctx.extend({ invocation }).credentialsController.authorize(KEY, 'oauth', signal)
}

async function collect(source: AsyncIterable<ProviderAuthorizationFrame>) {
  const frames: ProviderAuthorizationFrame[] = []
  for await (const frame of source) frames.push(frame)
  return frames
}

describe('provider-owned authorization over the credentials Remote', () => {
  it('describes registered methods and committed state without returning the grant', async () => {
    const ctx = await fixture(async () => {})
    expect(await ctx.credentialsController.authorization(KEY)).toEqual({
      key: KEY, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }], inFlight: false, configured: false,
    })
    await ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { access: 'private-token' } }))
    const state = await ctx.credentialsController.authorization(KEY)
    expect(state?.configured).toBe(true)
    expect(JSON.stringify(state)).not.toContain('private-token')
    expect(await ctx.credentialsController.authorization('llm-pi-ai/unknown')).toBeNull()
    await expect(ctx.credentialsController.authorization('not a key')).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('relays notices, select and manual-code prompts, then observes the provider commit', async () => {
    const ctx = await fixture(async (session) => {
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example/login', code: 'device-code' })
      const method = await session.prompt({ kind: 'select', message: 'Login method', options: [{ id: 'browser', label: 'Browser login' }] })
      expect(method).toBe('browser')
      const code = await session.prompt({ kind: 'text', message: 'Paste callback', placeholder: 'Authorization code' })
      expect(code).toBe('copied-code')
      await session.commit({ kind: 'grant', payload: { access: 'private-token' } })
    })
    const input = inputChannel()
    const frames: ProviderAuthorizationFrame[] = []
    for await (const frame of open(ctx, input.source, new AbortController().signal)) {
      frames.push(frame)
      if (frame.type === 'prompt') {
        input.send({ id: 'stale-question', value: 'ignored' })
        input.send({ id: frame.id, value: frame.prompt.kind === 'select' ? 'browser' : 'copied-code' })
      }
    }
    expect(frames.map(frame => frame.type)).toEqual(['notice', 'prompt', 'prompt', 'outcome'])
    expect(frames[0]).toEqual({ type: 'notice', notice: { message: 'Continue in your browser', url: 'https://auth.example/login', code: 'device-code' } })
    expect(frames.at(-1)).toEqual({ type: 'outcome', status: 'authorized' })
    expect(JSON.stringify(frames)).not.toContain('private-token')
    expect((await ctx.credentialsController.authorization(KEY))?.configured).toBe(true)
  })

  it('withdraws a manual prompt when a browser callback wins without cancelling the flow', async () => {
    const ctx = await fixture(async (session) => {
      const question = new AbortController()
      const result = session.prompt({ kind: 'text', message: 'Paste callback', signal: question.signal })
      question.abort(new Error('Browser callback won'))
      await expect(result).rejects.toThrow('Browser callback won')
      await session.commit({ kind: 'grant', payload: { access: 'private-token' } })
    })
    const frames = await collect(open(ctx, inputChannel().source, new AbortController().signal))
    expect(frames.map(frame => frame.type)).toEqual(['prompt', 'prompt-cancelled', 'outcome'])
    expect(frames.at(-1)).toEqual({ type: 'outcome', status: 'authorized' })
    expect(frames[0]).not.toHaveProperty('prompt.signal')
  })

  it('cancels an outstanding provider prompt when the Remote call is cancelled', async () => {
    const ctx = await fixture(async (session) => {
      await session.prompt({ kind: 'secret', message: 'Provider secret' })
      await session.commit({ kind: 'grant', payload: { access: 'must-not-commit' } })
    })
    const abort = new AbortController()
    const stream = open(ctx, inputChannel().source, abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { type: 'prompt', prompt: { kind: 'secret' } } })
    abort.abort()
    const rest = await collect({ [Symbol.asyncIterator]: () => stream })
    expect(rest.at(-1)).toEqual({ type: 'outcome', status: 'cancelled' })
    expect((await ctx.credentialsController.authorization(KEY))?.configured).toBe(false)
  })

  it('releases a pending attempt when its browser stops reading the stream', async () => {
    const ctx = await fixture(async (session) => { await session.prompt({ kind: 'text', message: 'Pending' }) })
    const stream = open(ctx, inputChannel().source, new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    await stream.return?.()
    expect((await ctx.credentialsController.authorization(KEY))?.inFlight).toBe(false)
  })

  it('keeps provider exceptions containing tokens out of Remote failures', async () => {
    const ctx = await fixture(async () => { throw new Error('token response: private-token') })
    const failure = await collect(open(ctx, inputChannel().source, new AbortController().signal)).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'credential/rejected', message: 'Provider authorization failed.', details: { ref: KEY } })
    expect(JSON.stringify(remoteErrorOf(failure))).not.toContain('private-token')
  })

  it('reports missing services and rejects a call without a Remote invocation', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(CredentialsController)
    expect(await ctx.credentialsController.authorization(KEY)).toBeNull()
    expect(() => ctx.credentialsController.authorize(KEY, 'oauth', new AbortController().signal))
      .toThrow('authorization service is absent')
    const configured = await fixture(async () => {})
    expect(() => configured.credentialsController.authorize(KEY, 'oauth', new AbortController().signal))
      .toThrow('provider authorization requires a Remote invocation')
  })
})
