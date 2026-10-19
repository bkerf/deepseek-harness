/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { AuthorizationEntry, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'

/** A registered provider sign-in and its stored credential state, without credential values. */
export interface ProviderAuthorization extends AuthorizationEntry {
  readonly configured: boolean
}

/** A provider question whose cancellation remains owned by the Host. */
export type ProviderAuthorizationPrompt =
  | Omit<Extract<AuthorizationPrompt, { kind: 'text' | 'secret' }>, 'signal'>
  | Omit<Extract<AuthorizationPrompt, { kind: 'select' }>, 'signal'>

/** Progress and human interaction carried by one provider sign-in stream. */
export type ProviderAuthorizationFrame =
  | { readonly type: 'notice'; readonly notice: AuthorizationNotice }
  | { readonly type: 'prompt'; readonly id: string; readonly prompt: ProviderAuthorizationPrompt }
  | { readonly type: 'prompt-cancelled'; readonly id: string }
  | { readonly type: 'outcome'; readonly status: 'authorized' | 'cancelled' }

/** The answer to one Host-issued provider question. */
export interface ProviderAuthorizationAnswer {
  readonly id: string
  readonly value: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
