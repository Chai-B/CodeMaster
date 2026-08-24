// Context Budget Scheduler — per-task-type allocation profiles (spec §11).

import { ContextComponent, type BudgetProfile } from '../types/index.js';
import type { TaskType } from '../types/index.js';

const C = ContextComponent;

export const BUDGET_PROFILES: Record<string, BudgetProfile> = {
  planning: {
    [C.OBJECTIVE]: 0.03,
    [C.EXECUTION_PLAN]: 0.05,
    [C.ARCHITECTURE]: 0.15,
    [C.REPOSITORY_MAP]: 0.15,
    [C.PRIOR_REASONING]: 0.2,
    [C.WIKI_SECTIONS]: 0.15,
    [C.RELEVANT_FILES]: 0.15,
    [C.CONVENTIONS]: 0.05,
    [C.CONSTRAINTS]: 0.05,
    scratchpad: 0.02,
  },
  implementation: {
    [C.OBJECTIVE]: 0.02,
    [C.CURRENT_TASK]: 0.05,
    [C.ARCHITECTURE]: 0.08,
    [C.REPOSITORY_MAP]: 0.1,
    [C.RELEVANT_FILES]: 0.45,
    [C.RECENT_CHANGES]: 0.1,
    [C.PRIOR_REASONING]: 0.08,
    [C.CONVENTIONS]: 0.08,
    [C.CONSTRAINTS]: 0.04,
  },
  debugging: {
    [C.OBJECTIVE]: 0.03,
    [C.CURRENT_TASK]: 0.05,
    [C.RECENT_CHANGES]: 0.25,
    [C.RELEVANT_FILES]: 0.35,
    [C.KNOWN_FAILURES]: 0.1,
    [C.PRIOR_REASONING]: 0.1,
    [C.ARCHITECTURE]: 0.07,
    [C.CONSTRAINTS]: 0.05,
  },
  refactoring: {
    [C.OBJECTIVE]: 0.03,
    [C.ARCHITECTURE]: 0.12,
    [C.REPOSITORY_MAP]: 0.25,
    [C.RELEVANT_FILES]: 0.35,
    [C.CONVENTIONS]: 0.1,
    [C.PRIOR_REASONING]: 0.1,
    [C.CONSTRAINTS]: 0.05,
  },
  testing: {
    [C.OBJECTIVE]: 0.03,
    [C.CURRENT_TASK]: 0.05,
    [C.RELEVANT_FILES]: 0.4,
    [C.CONVENTIONS]: 0.15,
    [C.ARCHITECTURE]: 0.1,
    [C.PRIOR_REASONING]: 0.15,
    [C.CONSTRAINTS]: 0.05,
    scratchpad: 0.07,
  },
  review: {
    [C.OBJECTIVE]: 0.03,
    [C.RECENT_CHANGES]: 0.3,
    [C.RELEVANT_FILES]: 0.3,
    [C.CONVENTIONS]: 0.15,
    [C.ARCHITECTURE]: 0.1,
    [C.PRIOR_REASONING]: 0.1,
    [C.CONSTRAINTS]: 0.02,
  },
};

// Map task type → budget profile name.
export function profileForTask(taskType: TaskType): string {
  switch (taskType) {
    case 'plan':
      return 'planning';
    case 'implement':
      return 'implementation';
    case 'debug':
      return 'debugging';
    case 'refactor':
      return 'refactoring';
    case 'test':
      return 'testing';
    case 'review':
    case 'verify':
      return 'review';
    default:
      return 'implementation';
  }
}

/**
 * Escalation ladder (spec §11, token-discipline W2). The percentages below are
 * shares of the budget actually granted, not of the model's whole window — the
 * old code multiplied by max_context_tokens, so every task filled ~176k
 * regardless of how small it was, and the file selector happily spent the
 * allowance it was handed. A task now starts on the smallest rung and only
 * climbs when a verification pass has actually failed at the current size.
 */
const LADDER = [24_000, 64_000, 160_000];

export function budgetForTier(maxContextTokens: number, tier: number): number {
  const rung = LADDER[Math.min(Math.max(tier, 0), LADDER.length - 1)]!;
  return Math.min(maxContextTokens, rung);
}

export function resolveBudget(
  taskType: TaskType,
  maxContextTokens: number,
  tier = 0,
): { profileName: string; allocations: Record<string, number>; budget: number } {
  const profileName = profileForTask(taskType);
  const profile = BUDGET_PROFILES[profileName]!;
  const budget = budgetForTier(maxContextTokens, tier);
  // Reserve ~12% for instructions + output format + system overhead.
  const usable = Math.floor(budget * 0.88);
  const allocations: Record<string, number> = {};
  for (const [component, pct] of Object.entries(profile)) {
    allocations[component] = Math.floor(usable * (pct ?? 0));
  }
  return { profileName, allocations, budget };
}
