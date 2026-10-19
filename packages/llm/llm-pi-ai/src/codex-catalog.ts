/** Account-specific Codex models and capabilities obtained with Harness-owned OAuth. */

import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { LlmError, ReasoningEffortId, ServiceTierId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, type ResolvedPiAiProviderProfile } from './config.ts'

// Codex filters its model catalog by client protocol version.
const CODEX_CLIENT_VERSION = '0.162.0'

const ULTRA_MULTI_AGENT_INSTRUCTIONS = 'Ultra proactive multi-agent delegation is active. '
  + 'Decompose independent work and use the available subagent or subagent_fork tools in parallel when that can save time or improve quality. '
  + 'Continue useful work while children run, and use send_message when coordination is needed. '
  + 'Wait for the delegated results, integrate them, and verify the combined result before completing the task. '
  + 'Follow user instructions and the available tools, configured delegation depth, and capacity budgets; '
  + 'carry out work directly when those existing limits prevent delegation.'

const catalogSchema = z.object({
  models: z.array(z.object({
    slug: z.string(), display_name: z.string(), description: z.string().nullish(),
    visibility: z.enum(['list', 'hide', 'none']),
    default_reasoning_level: z.string().nullish(),
    supported_reasoning_levels: z.array(z.object({ effort: z.string(), description: z.string() })),
    multi_agent_reasoning_effort: z.string().nullish(),
    service_tiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).default([]),
    default_service_tier: z.string().nullish(),
    input_modalities: z.array(z.enum(['text', 'image'])).default(['text', 'image']),
    context_window: z.number().nullish(),
  })),
})

/** The transport descriptor and the exact capabilities advertised by its account. */
export interface CodexCatalogModel {
  readonly model: Model<Api>
  readonly resolveReasoningEffort: (selected: string) => string
  readonly info: Pick<LlmResolvedModelInfo, 'description'> & {
    readonly reasoning: NonNullable<LlmResolvedModelInfo['reasoning']>
    readonly serviceTiers: NonNullable<LlmResolvedModelInfo['serviceTiers']>
  }
}

/** An immutable account-specific catalog captured by one operation. */
export interface CodexCatalog {
  readonly models: ReadonlyMap<string, CodexCatalogModel>
  readonly apiKey?: string
}

/** One adapter owns its catalog cache; switching a credential or profile replaces it. */
export class CodexModelCatalog {
  private cached: { access: string; profile: ResolvedPiAiProviderProfile; request: Promise<CodexCatalog> } | undefined

  /** Resolve fresh OAuth through pi-ai before reusing or fetching this account's catalog. */
  async resolve(
    models: Models,
    profile: ResolvedPiAiProviderProfile,
    apiKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<CodexCatalog> {
    const auth = await models.getAuth('openai-codex', {
      ...apiKey === undefined ? {} : { apiKey }, ...signal === undefined ? {} : { signal },
    })
    const access = auth?.auth.apiKey
    if (access === undefined) return { models: new Map() }
    if (this.cached?.access === access && this.cached.profile === profile) return this.cached.request
    const request = this.fetch(models, profile, access, signal)
    this.cached = { access, profile, request }
    void request.catch(() => {
      if (this.cached?.request === request) this.cached = undefined
    })
    return request
  }

  private async fetch(
    models: Models,
    profile: ResolvedPiAiProviderProfile,
    access: string,
    signal: AbortSignal | undefined,
  ): Promise<CodexCatalog> {
    // The account claim comes from the exact refreshed token used by this request.
    const accountId = await Promise.resolve().then(() => z.object({
      'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string() }),
    }).parse(JSON.parse(Buffer.from(access.split('.')[1] as string, 'base64url').toString('utf8')))
      ['https://api.openai.com/auth'].chatgpt_account_id).catch(() => {
      throw new LlmError('Codex credential has no account identity', 'INVALID_CREDENTIAL')
    })
    const baseURL = (profile.baseURL ?? 'https://chatgpt.com/backend-api').replace(/\/+$/, '')
    const response = await fetch(`${baseURL}/codex/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: {
        ...profile.headers,
        Authorization: `Bearer ${access}`,
        'ChatGPT-Account-Id': accountId,
        originator: 'codex_cli_rs', Accept: 'application/json',
      },
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new LlmError(`Codex model catalog request failed (${response.status})`, 'DISCOVERY_FAILED')
    const catalog = catalogSchema.parse(await response.json())
    const entries = new Map(catalog.models.filter(entry => entry.visibility === 'list').map((entry) => {
      const preferred = entry.multi_agent_reasoning_effort
      // Codex 0.162 resolves Ultra in protocol/src/openai_models/reasoning_effort.rs.
      const ultraEffort = preferred != null && preferred !== 'ultra'
        && entry.supported_reasoning_levels.some(level => level.effort === preferred)
        ? preferred
        : entry.supported_reasoning_levels.find(level => level.effort === 'max')?.effort
          ?? entry.supported_reasoning_levels.findLast(level => level.effort !== 'ultra')?.effort
          ?? 'medium'
      const base = models.getModel('openai-codex', entry.slug)
      const model: Model<Api> = {
        ...base,
        id: entry.slug, name: entry.display_name,
        api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: baseURL,
        reasoning: entry.supported_reasoning_levels.length > 0,
        // Account reasoning is supplied verbatim through onPayload, beyond pi-ai's canonical levels.
        thinkingLevelMap: { off: null },
        input: entry.input_modalities,
        contextWindow: entry.context_window ?? profile.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: base?.maxTokens ?? profile.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      const info: CodexCatalogModel['info'] = {
        ...entry.description == null ? {} : { description: entry.description },
        reasoning: {
          efforts: entry.supported_reasoning_levels.map(level => ({
            id: ReasoningEffortId(level.effort),
            name: `${level.effort.charAt(0).toUpperCase()}${level.effort.slice(1)}`,
            description: level.description,
            ...level.effort === 'ultra' ? { instructions: ULTRA_MULTI_AGENT_INSTRUCTIONS } : {},
          })),
          ...entry.default_reasoning_level == null ? {} : { defaultEffort: ReasoningEffortId(entry.default_reasoning_level) },
        },
        serviceTiers: {
          tiers: [
            { id: ServiceTierId('default'), name: 'Standard' },
            ...entry.service_tiers.filter(tier => tier.id !== 'default').map(tier => ({ ...tier, id: ServiceTierId(tier.id) })),
          ],
          defaultTier: ServiceTierId(entry.default_service_tier ?? 'default'),
        },
      }
      return [entry.slug, {
        model, info,
        resolveReasoningEffort: (selected: string) => selected === 'ultra' ? ultraEffort : selected,
      }] as const
    }))
    return { models: entries, apiKey: access }
  }
}
