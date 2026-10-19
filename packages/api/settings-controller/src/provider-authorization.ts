/** Duplex interaction for the existing provider-owned credential authorization flows. */

import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { PassThrough } from 'node:stream'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import { RemoteError, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { ProviderAuthorizationAnswer, ProviderAuthorizationFrame } from './types.ts'

/**
 * Translate flow prompts into duplex frames while the credential owner keeps every grant write.
 * @param authorization - registered provider flow service.
 * @param key - provider-owned credential address.
 * @param method - registered login method.
 * @param answers - answers from the initiating browser stream.
 * @param signal - cancellation of the initiating Remote call.
 * @returns only interaction frames and the authorization outcome.
 */
export async function* authorizeProvider(
  authorization: AuthorizationService,
  key: CredentialKey,
  method: string,
  answers: AsyncIterable<ProviderAuthorizationAnswer>,
  signal: AbortSignal,
): RemoteStream<ProviderAuthorizationFrame, ProviderAuthorizationAnswer> {
  const lifetime = new AbortController()
  const active = AbortSignal.any([signal, lifetime.signal])
  const output = new PassThrough({ objectMode: true })
  const pending = new Map<string, PromiseWithResolvers<string>>()
  const input = answers[Symbol.asyncIterator]()
  const inputTask = (async () => {
    for await (const answer of { [Symbol.asyncIterator]: () => input }) {
      pending.get(answer.id)?.resolve(answer.value)
    }
  })().catch((error: unknown) => { lifetime.abort(error) })
  const attempt = authorization.begin({
    key,
    method,
    signal: active,
    interaction: {
      notify: (notice) => { output.write({ type: 'notice', notice } satisfies ProviderAuthorizationFrame) },
      prompt: async (prompt) => {
        const id = randomUUID()
        const answer = Promise.withResolvers<string>()
        pending.set(id, answer)
        const { signal: questionSignal, ...question } = prompt
        const questionLifetime = AbortSignal.any([active, ...questionSignal === undefined ? [] : [questionSignal]])
        const withdrawal = addAbortListener(questionLifetime, () => {
          pending.delete(id)
          output.write({ type: 'prompt-cancelled', id } satisfies ProviderAuthorizationFrame)
          answer.reject(questionLifetime.reason)
        })
        output.write({ type: 'prompt', id, prompt: question } satisfies ProviderAuthorizationFrame)
        return answer.promise.finally(() => {
          withdrawal[Symbol.dispose]()
          pending.delete(id)
        })
      },
    },
  }).then((outcome) => {
    output.write({ type: 'outcome', status: outcome.status } satisfies ProviderAuthorizationFrame)
    output.end()
  }, (error: unknown) => {
    output.destroy(new RemoteError('credential/rejected', 'Provider authorization failed.', { ref: key }, { cause: error }))
  })
  try {
    for await (const frame of output) yield frame as ProviderAuthorizationFrame
  } finally {
    lifetime.abort()
    output.destroy()
    await input.return?.()
    await inputTask
    await attempt
  }
}
