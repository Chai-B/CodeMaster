// Provider + Account manager and selector (spec §13.2-13.3, §13.6).

import { now, id } from '../util/id.js';
import { throwIfCancelled } from '../util/cancel.js';
import { AnthropicAdapter, claudeCliAvailable } from './anthropic.js';
import { codexCliAvailable } from './codex.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { CodexAdapter } from './codex.js';
import { CredentialManager } from './credentials.js';
import { QuotaLedger, parseRetryAfterMs } from './quotaLedger.js';
import { bus } from '../events/bus.js';
import type { Config } from '../config.js';
import { ConversationLost } from '../types/index.js';
import type { Account, ProviderAdapter, ModelSpec, LlmRole, LlmEffort, LlmTier, TaskType, CompiledPrompt, ProviderRequest, ProviderResponse, TokenUsage } from '../types/index.js';

/** Anthropic's published ratios, and the closest thing to a cross-vendor norm.
 *  A spec that bills differently overrides them. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Cost of one call, with cached input priced as cached input.
 *
 * Exported because the savings report re-prices historical ledger rows and has
 * to agree with what is charged going forward, to the cent.
 */
export function costOfUsage(spec: ModelSpec, usage: TokenUsage): number {
  const read = usage.cache_read_tokens ?? 0;
  const write = usage.cache_write_tokens ?? 0;
  // Clamped because a provider that reports cache tokens *outside* its input
  // count would otherwise drive the fresh figure negative and refund the call.
  const fresh = Math.max(0, usage.input_tokens - read - write);
  const inPrice = spec.cost_per_1m_input;
  return (
    (fresh / 1_000_000) * inPrice +
    (read / 1_000_000) * inPrice * (spec.cache_read_multiplier ?? CACHE_READ_MULTIPLIER) +
    (write / 1_000_000) * inPrice * (spec.cache_write_multiplier ?? CACHE_WRITE_MULTIPLIER) +
    (usage.output_tokens / 1_000_000) * spec.cost_per_1m_output
  );
}

export interface SelectedProvider {
  adapter: ProviderAdapter;
  account: Account;
  model: string;
  spec: ModelSpec;
}

/** Roles whose work is a mechanical transform — a diff review, a module
 *  summary, a wiki merge. The answer is already in the input, so with no
 *  configured model they take the cheapest model on the default's own vendor. */
const DERIVED_CHEAP: ReadonlySet<LlmRole> = new Set<LlmRole>(['review', 'summarize', 'merge']);

/** Reasoning depth per role when the config does not name one. Only the oracle
 *  gets depth by default: it is the sole source of ground truth, and measured on
 *  config-precedence a shallow model burned three attempts and 108k tokens
 *  without producing a test that failed on the bug. The mechanical roles get
 *  none — thinking about a summary does not make it a better summary. */
const DERIVED_EFFORT: Partial<Record<LlmRole, LlmEffort>> = { oracle: 'medium' };

/** Extended-thinking budget per effort level, in tokens. */
const THINKING_BUDGET: Record<LlmEffort, number> = { low: 1024, medium: 4096, high: 12288 };

/** What a job looks like before it is sent, from numbers the caller already
 *  has. Everything is optional: a caller that knows nothing gets 'standard',
 *  which is the model it would have used anyway. */
export interface JobSignals {
  role: LlmRole;
  /** The task's own type, when the call belongs to one. */
  taskType?: TaskType;
  /** Files the job has to reason across. */
  files?: number;
  /** Tokens of context it will carry, when that is known before compiling. */
  contextTokens?: number;
  /** Context-budget tier this attempt runs at. Above zero means either a pass
   *  already failed at the smaller budget or this repository has needed a
   *  bigger window for this kind of task before — both say harder than usual. */
  contextTier?: number;
  /** The answer is read by a person rather than applied and re-verified. No
   *  gate catches a weak one, so a prose deliverable never drops below the
   *  default model. */
  prose?: boolean;
}

/**
 * Which tier one job is worth — the whole of the automatic part of routing.
 *
 * A pure function of numbers the caller already holds, so the same job always
 * routes the same way and a run can be explained after the fact. It only
 * decides a *class*; which model that class names depends on the configured
 * default and on what the vendor actually offers (see `tierModel`).
 *
 * The mechanical roles are settled by their role alone: a diff review or a
 * module summary is a transform of text already in the prompt, and no amount of
 * model buys a better one. Everything else scores on what the job carries.
 */
export function tierFor(s: JobSignals): LlmTier {
  if (DERIVED_CHEAP.has(s.role)) return 'light';

  let score = 0;
  // Finding a fault and reshaping code across files are the two jobs where a
  // cheaper model loops instead of converging. Writing a patch or a plan starts
  // one rung down but still never at the bottom: a patch that will not apply
  // costs an entire extra iteration, which is more than the cheaper model saved.
  // Reading code and writing a test are the jobs that survive the bottom rung.
  if (s.taskType === 'debug' || s.taskType === 'refactor') score += 2;
  else if (s.taskType === 'implement' || s.taskType === 'plan') score += 1;

  const files = s.files ?? 0;
  const tokens = s.contextTokens ?? 0;
  if (files > 8 || tokens > 40_000) score += 2;
  else if (files > 2 || tokens > 12_000) score += 1;

  if ((s.contextTier ?? 0) > 0) score += 2;

  if (score >= 3) return 'heavy';
  if (score <= 0) return s.prose ? 'standard' : 'light';
  return 'standard';
}

const ENV_REF: Record<string, string> = {
  anthropic: 'env:ANTHROPIC_API_KEY',
  openai: 'env:OPENAI_API_KEY',
  google: 'env:GEMINI_API_KEY',
  'openai-codex': 'env:OPENAI_API_KEY',
};

/**
 * Which request actually goes to the vendor, given a conversation the solver is
 * carrying. Three cases, in order: the adapter cannot resume, so it gets the
 * full context and no conversation; this vendor has not seen the conversation
 * yet, so it opens one under that id with the full context; this vendor already
 * holds it, so it gets only the new turn.
 */
export function continuationRequest(
  full: ProviderRequest,
  conv: { id: string; turn: number; provider_id?: string; delta: string } | undefined,
  adapterSupports: boolean,
  providerId: string,
): ProviderRequest {
  if (!conv || !adapterSupports) return full;
  const holds = conv.provider_id === providerId;
  if (!holds || conv.turn === 0 || !conv.delta) {
    return { ...full, conversation: { id: conv.id, resume: false } };
  }
  return { ...full, user: conv.delta, conversation: { id: conv.id, resume: true } };
}

/** Whether a model can be reached at all. Free-standing because the callers
 *  that need it most — the wiki bootstrap gate, `/memory compress`, `/wiki
 *  update` — each hand-rolled their own env-var list, and they disagreed: one
 *  accepted the Claude CLI, one accepted only ANTHROPIC_API_KEY, none looked at
 *  stored credentials. A gate that is stricter than the call it guards refuses
 *  work the system could actually do. */
export function anyProviderAvailable(): boolean {
  const env = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  ];
  if (env.some((k) => process.env[k])) return true;
  if (CredentialManager.list().length > 0) return true;
  return claudeCliAvailable() || codexCliAvailable();
}

export class ProviderManager {
  private adapters = new Map<string, ProviderAdapter>();
  private accounts: Account[] = [];
  private modelToProvider = new Map<string, string>();
  /** Set by `/account use` — session-scoped, never written to config. */
  private preferred?: string;

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
    return anyProviderAvailable();
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

  /** Whether this account's credential can actually be produced at call time.
   *  An env-backed account whose variable is unset is a placeholder the
   *  constructor makes for every vendor, not an account anyone can call. */
  private resolves(a: Account): boolean {
    if (a.credential_ref.startsWith('cred:')) return CredentialManager.has(a.credential_ref.slice(5));
    if (a.credential_ref.startsWith('env:')) {
      return !!process.env[a.credential_ref.slice(4)] || this.envOrCliCredentials(a.provider_id);
    }
    return true;
  }

  /** `/account use <alias>` — an explicit choice outranks a latency measurement. */
  private preference(a: Account): number {
    return this.preferred && a.alias === this.preferred ? 1 : 0;
  }

  /** Returns false if no such account, so the command can say so by name. */
  useAccount(alias: string): boolean {
    if (!this.accounts.some((a) => a.alias === alias)) return false;
    this.preferred = alias;
    return true;
  }

  activeAccount(): string | undefined {
    return this.preferred;
  }

  /** For `/account` and `/doctor`: presence is not the same as usable. */
  accountResolves(a: Account): boolean {
    return this.resolves(a);
  }

  /** Account selector (spec §13.3) — health → capacity → rate → context → score. */
  select(modelId: string, requiredTokens: number): SelectedProvider {
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

    // Latency alone. There used to be a `capabilityMatch(providerId, taskType)`
    // factor here, but `candidates` is already filtered to one provider, so it
    // returned the same constant for every entry — a common factor that cannot
    // change a sort. Which MODEL to use is decided in `modelFor`, above the
    // account choice; this only picks which account of that model answers.
    // The constructor seeds an env-backed `default` account for every vendor
    // whether or not that variable is set, and every fresh account scores the
    // same on latency — so a stable sort handed the placeholder the win on
    // insertion order alone, and the adapter threw "no API key" with a working
    // stored key sitting one entry below it.
    const usable = candidates.filter((a) => this.resolves(a));
    if (candidates.length && !usable.length) {
      throw new Error(`No usable credential for ${providerId}. Add one with: /account add ${providerId} <alias> <key>`);
    }

    const scored = usable
      .map((a) => ({ a, score: 1 / Math.max(1, a.health.avg_latency_ms || 1) }))
      .sort((x, y) => this.preference(y.a) - this.preference(x.a) || y.score - x.score);

    const account = scored[0]?.a ?? this.accounts.find((a) => a.provider_id === providerId) ?? this.accounts[0]!;
    return { adapter, account, model: spec.id, spec };
  }

  /**
   * The model one call should use.
   *
   * A pin beats everything — it is a promise that every call in the run used
   * that exact model, and a benchmark whose pin leaked measured nothing. Then
   * an explicitly requested model (solver escalation, a session's /model, a
   * proxy client naming one), then the role table, then the global default.
   *
   * A model that does not exist, or whose vendor has no credentials, is not a
   * choice — it falls through rather than failing, so a stale `roles` entry
   * degrades to the default instead of breaking the run.
   */
  modelFor(role?: LlmRole, requested?: string, tier?: LlmTier): string {
    const def = this.cfg.providers.default;
    if (this.cfg.providers.pinned) return def;
    for (const want of [requested, role ? this.roleModel(role, tier) : undefined]) {
      if (want && this.modelSpec(want) && this.providerHasCredentials(this.providerOf(want))) return want;
    }
    if (this.providerHasCredentials(this.providerOf(def))) return def;
    // The default's own vendor has no key either. Holding a usable key for some
    // other vendor should mean the tool runs: the config ships a default and
    // most people never edit it, so failing on it strands a working credential.
    return this.cheapestCredentialed() ?? def;
  }

  private cheapestCredentialed(): string | undefined {
    return this.listModels()
      .filter((m) => this.providerHasCredentials(this.providerOf(m.id)))
      .sort((a, b) => a.cost_per_1m_output - b.cost_per_1m_output)[0]?.id;
  }

  /** A role with no configured model. The mechanical transforms — a diff review,
   *  a module summary, a wiki merge — go to the cheapest model on the default's
   *  own vendor; anything that has to reason stays on the default. Derived
   *  rather than shipped, so an old config gains a routing table without being
   *  edited, and moving `providers.default` moves the whole table with it. */
  private roleModel(role: LlmRole, tier?: LlmTier): string {
    const configured = this.routing(role).model;
    if (configured) return configured;
    if (tier) return this.tierModel(tier);
    if (!DERIVED_CHEAP.has(role)) return this.cfg.providers.default;
    return this.cheapestOn(this.providerOf(this.cfg.providers.default));
  }

  /** The model a tier names, on the default's own vendor.
   *
   *  'standard' is the configured default, so setting `providers.default` still
   *  decides what ordinary work runs on and the automatic part only moves off
   *  it in the two directions the job asked for: down to the vendor's cheapest
   *  model for work that is a small edit, up to its strongest for work that is
   *  not. Staying on one vendor keeps the conversation resumable and keeps a
   *  step up from crossing into a vendor the user has no key for; failover
   *  handles the case where the vendor itself is gone. */
  private tierModel(tier: LlmTier): string {
    const def = this.cfg.providers.default;
    if (tier === 'standard') return def;
    const ranked = this.listModels()
      .filter((m) => this.providerOf(m.id) === this.providerOf(def))
      .sort((a, b) => a.cost_per_1m_output - b.cost_per_1m_output);
    if (!ranked.length) return def;
    if (tier === 'light') return ranked[0]!.id;
    // A default the user set above everything the vendor lists is still the
    // default: 'heavy' may never resolve to something weaker than 'standard'.
    const top = ranked[ranked.length - 1]!;
    return top.cost_per_1m_output >= (this.modelSpec(def)?.cost_per_1m_output ?? 0) ? top.id : def;
  }

  /** A role's entry, normalised — a bare string is a model id at default effort. */
  private routing(role: LlmRole): { model?: string; effort?: LlmEffort } {
    const r = this.cfg.providers.roles?.[role];
    return typeof r === 'string' ? { model: r } : (r ?? {});
  }

  /**
   * How hard this call should think, as an extended-thinking budget in tokens.
   *
   * Effort is orthogonal to model choice: opus at 'low' and opus at 'high' are
   * the same weights at very different prices, so a role can buy reasoning
   * depth without buying a bigger model — and the mechanical roles can buy a
   * big model without paying for depth they have no use for.
   *
   * Unset means the vendor default (no explicit budget). Under a pin, effort is
   * suppressed with everything else: a pinned run promises one model answering
   * one way, and thinking depth changes the answer.
   */
  effortFor(role?: LlmRole, requested?: LlmEffort, tier?: LlmTier): number | undefined {
    if (this.cfg.providers.pinned) return undefined;
    // A job routed to the strongest model is one the signals called hard, and
    // depth is the cheaper half of that answer — it buys reasoning without
    // buying a second call at the top price.
    const derived = role ? this.routing(role).effort ?? DERIVED_EFFORT[role] : undefined;
    const effort = requested ?? derived ?? (tier === 'heavy' ? 'medium' : undefined);
    if (!effort) return undefined;
    return THINKING_BUDGET[effort];
  }

  private cheapestOn(providerId: string): string {
    return (
      this.listModels()
        .filter((m) => this.providerOf(m.id) === providerId)
        .sort((a, b) => a.cost_per_1m_output - b.cost_per_1m_output)[0]?.id ?? this.cfg.providers.default
    );
  }

  /** The model on `providerId` closest in price to `head`. A rescue has to
   *  answer the same question at the same class: taking each vendor's first
   *  listed model sent a haiku-routed summary to opus at fifteen times the price. */
  private nearestOn(providerId: string, head: string): string | undefined {
    const target = this.modelSpec(head)?.cost_per_1m_output ?? 0;
    return this.listModels()
      .filter((m) => this.providerOf(m.id) === providerId)
      .sort((a, b) => Math.abs(a.cost_per_1m_output - target) - Math.abs(b.cost_per_1m_output - target))[0]?.id;
  }

  /** Whether a provider actually has usable credentials — so failover never tries
   *  a keyless provider and throws a confusing error (spec §13.3 filter by health).
   *
   *  Env and CLI are asked first: they are the common case and cost nothing. But a
   *  key added through `/account add` lives only in the credential store, and a
   *  vendor invisible here is invisible to `modelFor` (role routing),
   *  `failoverModelOrder` (rescue) and `strongerThan` (escalation) — so a stored
   *  key that the adapters can already resolve would never be reached at all. */
  providerHasCredentials(providerId: string): boolean {
    if (this.envOrCliCredentials(providerId)) return true;
    return this.accounts.some(
      (a) =>
        a.provider_id === providerId &&
        a.credential_ref.startsWith('cred:') &&
        CredentialManager.has(a.credential_ref.slice(5)),
    );
  }

  private envOrCliCredentials(providerId: string): boolean {
    switch (providerId) {
      case 'anthropic':
        return claudeCliAvailable() || !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
      case 'openai':
        return !!process.env.OPENAI_API_KEY;
      case 'openai-codex':
        return !!process.env.OPENAI_API_KEY || codexCliAvailable();
      case 'google':
        return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
      default:
        return true;
    }
  }

  /**
   * The next model up from this one, or null if it is already the strongest
   * available. Output price is the ranking: within and across vendors, the
   * model that costs more per generated token is the more capable one, and it
   * is the only capability signal the config actually carries.
   *
   * Used when a cheap model has failed the same way twice — measured on the
   * benchmark, two iterations of haiku produced byte-identical failures, and a
   * third would have produced a third. Escalating one stuck task is what makes
   * the layer worth more than the model it started on.
   */
  strongerThan(modelId: string): string | null {
    const here = this.listModels().find((m) => m.id === modelId);
    if (!here) return null;
    const better = this.listModels()
      .filter((m) => m.cost_per_1m_output > here.cost_per_1m_output && this.providerHasCredentials(this.providerOf(m.id)))
      .sort((a, b) => a.cost_per_1m_output - b.cost_per_1m_output);
    // The cheapest model that is still stronger — one rung, not the top of the
    // list. A stuck task should cost the smallest increment that might solve it.
    return better[0]?.id ?? null;
  }

  /** Provider preference order for one call: the model this call should use
   *  first (spec §26.7), then one stand-in per other credentialed vendor. */
  private failoverModelOrder(head: string): string[] {
    const def = this.cfg.providers.default;
    // A pinned model is a promise that every call used it. Walking to another
    // vendor keeps the run alive but silently answers a different question —
    // measured, a benchmark pinned to haiku failed over to gpt-5-codex mid-run
    // and its numbers meant nothing. Re-checked here and not only in `modelFor`
    // because this list is the last thing between a routed call and the vendor:
    // no role and no escalation may widen it. Accounts of this same model are
    // still tried; `select` and `available` handle that below.
    if (this.cfg.providers.pinned) return [def];
    const seenProvider = new Set<string>();
    const order: string[] = [];
    if (this.providerHasCredentials(this.providerOf(head))) {
      order.push(head);
      seenProvider.add(this.providerOf(head));
    }
    // One model per remaining CREDENTIALED provider, so failover switches
    // providers — and the one nearest `head` in price, so a rescue answers the
    // same question at the same class.
    for (const m of this.listModels()) {
      const pid = this.providerOf(m.id);
      if (!seenProvider.has(pid) && this.providerHasCredentials(pid)) {
        seenProvider.add(pid);
        const near = this.nearestOn(pid, head);
        if (near) order.push(near);
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
    // Fallback: if nothing is credentialed, still try head so the error is honest.
    return order.length ? order : [head];
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
  /**
   * One provider call, continuing the vendor's own conversation when it can.
   * The vendor CLI re-charges its whole system prompt on every fresh
   * invocation, so a solver that iterates three times pays that floor three
   * times unless the conversation is resumed. Resuming sends only the new turn.
   */
  private async invokeOne(
    sel: SelectedProvider,
    prompt: CompiledPrompt,
    conv?: { id: string; turn: number; provider_id?: string; delta: string },
    onConversation?: (id: string, providerId: string) => void,
    thinkingTokens?: number,
  ): Promise<ProviderResponse> {
    const pid = sel.adapter.provider_id;
    const full = (): ProviderRequest => ({
      ...sel.adapter.format_prompt(prompt, sel.model),
      thinking_tokens: thinkingTokens,
    });
    const canResume = sel.adapter.continuation_available
      ? sel.adapter.continuation_available(sel.account)
      : !!sel.adapter.supports_continuation;
    const request = continuationRequest(full(), conv, canResume, pid);

    if (!request.conversation) return invokeWithBackoff(() => sel.adapter.invoke(request, sel.account));
    try {
      const r = await invokeWithBackoff(() => sel.adapter.invoke(request, sel.account));
      onConversation?.(request.conversation.id, pid);
      return r;
    } catch (e) {
      if (!(e instanceof ConversationLost)) throw e;
      // The vendor dropped the conversation; the full context still says
      // everything the delta assumed, so one honest retry recovers the turn.
      bus.emit({ type: 'log', level: 'warn', message: 'Vendor conversation expired; resending full context.' });
      const r = await invokeWithBackoff(() => sel.adapter.invoke(full(), sel.account));
      onConversation?.(request.conversation.id, pid);
      return r;
    }
  }

  async invokeWithFailover(
    compiled: CompiledPrompt,
    requiredTokens: number,
    role?: LlmRole,
    opts?: {
      onVendorSwitch?: (from: string, to: string) => Promise<CompiledPrompt>;
      /** Continue one vendor-side conversation across solver iterations. `delta`
       *  is the only content sent when resuming; the full prompt is kept so a
       *  lost conversation or a vendor switch can fall back to it. */
      conversation?: { id: string; turn: number; provider_id?: string; delta: string };
      /** Called when a conversation was actually opened or continued, so the
       *  caller can bind the id to the vendor that owns it. */
      onConversation?: (id: string, providerId: string) => void;
      /** This call, on this model — solver escalation, a session's /model, a
       *  proxy client naming one. Loses to a pin; see modelFor. */
      model?: string;
      /** Override the role's reasoning depth for this call. */
      effort?: LlmEffort;
      /** How much model this job is worth, from `tierFor`. Loses to a pin, to
       *  an explicitly requested model and to a configured role entry. */
      tier?: LlmTier;
    },
  ): Promise<{ sel: SelectedProvider; response: ProviderResponse }> {
    let lastErr: unknown;
    let prompt = compiled;
    let lastProvider: string | undefined;
    const tried: string[] = [];

    const thinking = this.effortFor(role, opts?.effort, opts?.tier);
    for (const model of this.failoverModelOrder(this.modelFor(role, opts?.model, opts?.tier))) {
      // A cancelled run must not walk on to the next vendor.
      throwIfCancelled();
      const sel = this.select(model, requiredTokens);
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
        const response = await this.invokeOne(sel, prompt, opts?.conversation, opts?.onConversation, thinking);
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

  /**
   * What the vendor actually bills for one call.
   *
   * `input_tokens` is the whole billed input, cache included. Charging all of
   * it at the fresh rate is what made a resumed conversation read as several
   * times its real price: a prefix-cache read costs a tenth of a fresh token,
   * and on a long conversation nearly every input token is a cache read.
   *
   * Answers served from our own cache never reach a provider and are never
   * recorded, so they cost nothing here by construction.
   */
  costOf(spec: ModelSpec, usage: TokenUsage): number {
    return costOfUsage(spec, usage);
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
