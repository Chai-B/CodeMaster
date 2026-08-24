// Provider + Account manager and selector (spec §13.2-13.3, §13.6).

import { now, id } from '../util/id.js';
import { AnthropicAdapter, claudeCliAvailable } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { CodexAdapter } from './codex.js';
import { CredentialManager } from './credentials.js';
import { QuotaLedger, parseRetryAfterMs } from './quotaLedger.js';
import { bus } from '../events/bus.js';
import type { Config } from '../config.js';
import type { Account, ProviderAdapter, ModelSpec, TaskType, CompiledPrompt, ProviderResponse } from '../types/index.js';

export interface SelectedProvider {
  adapter: ProviderAdapter;
  account: Account;
  model: string;
  spec: ModelSpec;
}

const ENV_REF: Record<string, string> = {
  anthropic: 'env:ANTHROPIC_API_KEY',
  openai: 'env:OPENAI_API_KEY',
  google: 'env:GEMINI_API_KEY',
  'openai-codex': 'env:OPENAI_API_KEY',
};

const UNAVAILABLE_COOLDOWN_MS = 60_000;

export class ProviderManager {
  private adapters = new Map<string, ProviderAdapter>();
  private accounts: Account[] = [];
  private modelToProvider = new Map<string, string>();

  constructor(private cfg: Config) {
    this.adapters.set('anthropic', new AnthropicAdapter(cfg.providers.anthropic.models));
    this.adapters.set('openai', new OpenAIAdapter(cfg.providers.openai.models));
    this.adapters.set('google', new GeminiAdapter(cfg.providers.google.models));
    this.adapters.set('openai-codex', new CodexAdapter(cfg.providers.openai_codex.models));

    for (const [pid, group] of [
      ['anthropic', cfg.providers.anthropic],
      ['openai', cfg.providers.openai],
      ['google', cfg.providers.google],
      ['openai-codex', cfg.providers.openai_codex],
    ] as const) {
      for (const m of group.models) this.modelToProvider.set(m.id, pid);
      this.accounts.push(this.makeAccount(pid, 'default', ENV_REF[pid]!));
    }

    // Restore any stored encrypted accounts.
    for (const credId of CredentialManager.list()) {
      const [pid, alias] = credId.split('::');
      if (pid && this.adapters.has(pid)) this.accounts.push(this.makeAccount(pid, alias ?? 'stored', `cred:${credId}`));
    }
  }

  /**
   * True when some path to an LLM exists: an env key, a stored credential, or
   * the authenticated `claude` CLI (subscription mode). Commands gate on this
   * rather than on ANTHROPIC_API_KEY, which locked out OpenAI/Gemini users and
   * the `claude setup-token` users the startup banner invites.
   */
  hasAnyProvider(): boolean {
    const env = [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    ];
    if (env.some((k) => process.env[k])) return true;
    if (CredentialManager.list().length > 0) return true;
    return claudeCliAvailable();
  }

  private makeAccount(providerId: string, alias: string, credRef: string): Account {
    const ctx = this.adapters.get(providerId)?.capabilities.max_context_tokens ?? 200_000;
    return {
      id: id('acct'),
      provider_id: providerId,
      alias,
      credential_ref: credRef,
      auth_type: 'api_key',
      quota: {
        daily_token_limit: 50_000_000,
        tokens_used_today: 0,
        rate_limit_rpm: 50,
        rate_limit_tpm: 200_000,
        current_rpm: 0,
        current_tpm: 0,
        context_size: ctx,
        resets_at: now(),
      },
      health: {
        status: 'healthy',
        last_latency_ms: 0,
        avg_latency_ms: 0,
        error_rate_last_hour: 0,
        last_checked_at: now(),
      },
      last_used_at: now(),
    };
  }

  providerOf(modelId: string): string {
    return this.modelToProvider.get(modelId) ?? 'anthropic';
  }

  listProviders(): string[] {
    return [...this.adapters.keys()];
  }
  listModels(): ModelSpec[] {
    return [
      ...this.cfg.providers.anthropic.models,
      ...this.cfg.providers.openai.models,
      ...this.cfg.providers.google.models,
      ...this.cfg.providers.openai_codex.models,
    ];
  }
  listAccounts(): Account[] {
    return this.accounts;
  }
  modelSpec(modelId: string): ModelSpec | undefined {
    return this.listModels().find((m) => m.id === modelId);
  }

  addAccount(providerId: string, alias: string, apiKey: string): Account | null {
    if (!this.adapters.has(providerId)) return null;
    const credId = `${providerId}::${alias}`;
    CredentialManager.store(credId, apiKey);
    const acct = this.makeAccount(providerId, alias, `cred:${credId}`);
    this.accounts.push(acct);
    return acct;
  }

  removeAccount(alias: string): boolean {
    const idx = this.accounts.findIndex((a) => a.alias === alias && a.credential_ref.startsWith('cred:'));
    if (idx < 0) return false;
    const acct = this.accounts[idx]!;
    CredentialManager.delete(acct.credential_ref.slice(5));
    this.accounts.splice(idx, 1);
    return true;
  }

  /** Account selector (spec §13.3) — health → capacity → rate → context → score. */
  select(modelId: string, requiredTokens: number, taskType?: TaskType): SelectedProvider {
    const providerId = this.providerOf(modelId);
    const spec = this.modelSpec(modelId) ?? this.cfg.providers.anthropic.models[0]!;
    const adapter = this.adapters.get(providerId)!;

    // Filtered on facts only: the account is not rate-limited or cooling down,
    // and the model's window actually fits the request. The old filters divided
    // by an invented 50M daily limit that no vendor ever reported.
    const candidates = this.accounts
      .filter((a) => a.provider_id === providerId)
      .filter((a) => this.available(a))
      .filter((a) => a.quota.context_size >= requiredTokens);

    const scored = candidates
      .map((a) => ({
        a,
        score:
          this.capabilityMatch(providerId, taskType) *
          (1 / Math.max(1, a.health.avg_latency_ms || 1)),
      }))
      .sort((x, y) => y.score - x.score);

    const account = scored[0]?.a ?? this.accounts.find((a) => a.provider_id === providerId) ?? this.accounts[0]!;
    return { adapter, account, model: spec.id, spec };
  }

  private capabilityMatch(providerId: string, taskType?: TaskType): number {
    const c = this.adapters.get(providerId)?.characteristics;
    if (!c) return 1;
    if (taskType === 'plan') return c.planning_quality;
    if (taskType === 'refactor') return c.refactoring_quality;
    return c.code_generation_quality;
  }

  /** Whether a provider actually has usable credentials — so failover never tries
   *  a keyless provider and throws a confusing error (spec §13.3 filter by health). */
  providerHasCredentials(providerId: string): boolean {
    switch (providerId) {
      case 'anthropic':
        return claudeCliAvailable() || !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
      case 'openai':
      case 'openai-codex':
        return !!process.env.OPENAI_API_KEY;
      case 'google':
        return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
      default:
        return true;
    }
  }

  /** Provider preference order for failover: configured default first (spec §26.7),
   *  restricted to providers that actually have credentials. */
  private failoverModelOrder(): string[] {
    const def = this.cfg.providers.default;
    const seenProvider = new Set<string>();
    const order: string[] = [];
    if (this.providerHasCredentials(this.providerOf(def))) {
      order.push(def);
      seenProvider.add(this.providerOf(def));
    }
    // One model per remaining CREDENTIALED provider, so failover switches providers.
    for (const m of this.listModels()) {
      const pid = this.providerOf(m.id);
      if (!seenProvider.has(pid) && this.providerHasCredentials(pid)) {
        seenProvider.add(pid);
        order.push(m.id);
      }
    }
    // Vendors that are usable right now go first, so a spent Claude window does
    // not cost a failed call before Codex is tried. Ordering only — a blocked
    // vendor stays in the list, and its own guard skips it.
    const blocked = (modelId: string): number => {
      const pid = this.providerOf(modelId);
      const acct = this.accounts.find((a) => a.provider_id === pid);
      return acct && !this.available(acct) ? 1 : 0;
    };
    order.sort((a, b) => blocked(a) - blocked(b));
    // Fallback: if nothing is credentialed, still try the default so the error is honest.
    return order.length ? order : [def];
  }

  /** Ledger key for an account: stable across process restarts, unlike its id. */
  private key(account: Account): string {
    return `${account.provider_id}::${account.alias}`;
  }

  /**
   * Usable right now: not inside a vendor-reported rate limit and not inside a
   * failure cooldown. State lives in the ledger, so a limit hit in one process
   * is still known to the next — previously every restart forgot it, and a
   * single error disabled an account for the whole process lifetime.
   */
  private available(account: Account): boolean {
    return QuotaLedger.available(this.key(account), account.provider_id);
  }

  /**
   * Compile → invoke with exponential backoff, automatically failing over to the
   * next healthy provider when one is unavailable (spec §13, §26.7).
   */
  async invokeWithFailover(
    compiled: CompiledPrompt,
    requiredTokens: number,
    taskType?: TaskType,
    opts?: { onVendorSwitch?: (from: string, to: string) => Promise<CompiledPrompt> },
  ): Promise<{ sel: SelectedProvider; response: ProviderResponse }> {
    let lastErr: unknown;
    let prompt = compiled;
    let lastProvider: string | undefined;
    const tried: string[] = [];

    for (const model of this.failoverModelOrder()) {
      const sel = this.select(model, requiredTokens, taskType);
      if (!this.available(sel.account)) continue;
      const pid = sel.adapter.provider_id;
      const key = this.key(sel.account);

      // Crossing a vendor boundary mid-task is exactly when the session's
      // reasoning would otherwise be lost: the new vendor has none of the
      // context the old one accumulated. Recompile with a handoff package so it
      // resumes the task instead of restarting it.
      if (lastProvider && lastProvider !== pid) {
        bus.emit({ type: 'provider.switched', from: lastProvider, to: pid });
        if (opts?.onVendorSwitch) {
          try {
            prompt = await opts.onVendorSwitch(lastProvider, pid);
          } catch (e) {
            bus.emit({ type: 'log', level: 'warn', message: `Handoff compilation failed, continuing without it: ${String(e)}` });
          }
        }
      }
      lastProvider = pid;
      tried.push(pid);

      try {
        const request = sel.adapter.format_prompt(prompt, sel.model);
        const response = await invokeWithBackoff(() => sel.adapter.invoke(request, sel.account));
        QuotaLedger.recordSuccess(key, pid);
        sel.account.health.status = 'healthy';
        return { sel, response };
      } catch (e) {
        lastErr = e;
        sel.account.health.status = 'degraded';
        sel.account.health.unavailable_reason = String(e);
        const retryAfterMs = parseRetryAfterMs(e);
        if (retryAfterMs !== null) {
          this.markRateLimited(sel.account, retryAfterMs);
          // A limit measured in hours is a spent subscription window, not a
          // burst limit — the distinction decides whether waiting is worth it.
          if (retryAfterMs > 10 * 60_000) bus.emit({ type: 'quota.exhausted', account_id: sel.account.id });
        } else {
          QuotaLedger.recordFailure(key, pid, String(e));
        }
        bus.emit({ type: 'provider.error', provider_id: pid, error: String(e) });
      }
    }

    if (lastErr) throw lastErr;
    // Nothing was even attempted: say which vendors are blocked and for how
    // long, rather than the bare "no available provider account" that left a
    // failed run with no explanation.
    const blocked = this.accounts
      .filter((a) => this.providerHasCredentials(a.provider_id) && !this.available(a))
      .map((a) => `${a.provider_id} (${Math.ceil(QuotaLedger.blockedForMs(this.key(a), a.provider_id) / 1000)}s)`);
    throw new Error(
      blocked.length
        ? `No provider available — rate-limited or cooling down: ${[...new Set(blocked)].join(', ')}`
        : `No provider available${tried.length ? ` (tried ${tried.join(', ')})` : ' — no credentialed provider found'}`,
    );
  }

  /** Health-check every account (spec §13 provider health monitoring). */
  async pingAll(): Promise<void> {
    await Promise.all(this.accounts.map((a) => this.ping(a).catch(() => undefined)));
  }

  recordUsage(account: Account, totalTokens: number, latencyMs: number): void {
    account.quota.tokens_used_today += totalTokens;
    account.quota.current_rpm += 1;
    account.last_used_at = now();
    account.health.last_latency_ms = latencyMs;
    account.health.avg_latency_ms = account.health.avg_latency_ms
      ? (account.health.avg_latency_ms + latencyMs) / 2
      : latencyMs;
    // Persisted so a subscription window's spend survives a restart. There is
    // no threshold warning here any more: the old one fired at 80% of an
    // invented 50M daily limit, a number no vendor has ever reported.
    QuotaLedger.recordUsage(this.key(account), account.provider_id, totalTokens);
  }

  markRateLimited(account: Account, retryAfterMs: number): void {
    account.health.status = 'degraded';
    QuotaLedger.markRateLimited(this.key(account), account.provider_id, retryAfterMs);
    bus.emit({ type: 'provider.rate_limited', account_id: account.id, retry_after_ms: retryAfterMs });
  }

  async ping(account: Account): Promise<void> {
    const adapter = this.adapters.get(account.provider_id);
    if (!adapter) return;
    account.health.status = await adapter.ping(account);
    account.health.last_checked_at = now();
  }

  costOf(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1_000_000) * spec.cost_per_1m_input + (outputTokens / 1_000_000) * spec.cost_per_1m_output;
  }
}

/** Invoke with exponential backoff on rate limits (spec §13). */
export async function invokeWithBackoff<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  let attempt = 0;
  let delay = 1000;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e);
      const rateLimited = /rate.?limit|429|overloaded|529|empty response|empty result|no output|transient/i.test(msg);
      if (!rateLimited || attempt >= maxRetries) throw e;
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay + Math.random() * 250));
      delay *= 2;
    }
  }
}
