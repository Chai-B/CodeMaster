// Reasoning objects — first-class persistent reasoning (spec §8).

import type { ISO8601, FileRef, ProviderRef, Evidence, Alternative } from './common.js';

export type ReasoningType =
  | 'decision'
  | 'observation'
  | 'hypothesis'
  | 'risk'
  | 'assumption'
  | 'constraint'
  /** The model's own thinking, as the vendor returned it. Billed as output
   *  whether or not it is read, so it is kept rather than discarded. */
  | 'thinking';

export interface ReasoningBase {
  id: string;
  type: ReasoningType;
  session_id: string;
  task_id: string;

  summary: string; // one sentence
  detail: string; // full elaboration

  evidence: Evidence[];
  confidence: number; // 0.0 – 1.0

  produced_by: ProviderRef;
  produced_at: ISO8601;

  affected_files: FileRef[];
  affected_modules: string[];

  tags: string[];
  permanent: boolean;

  wiki_keys: string[];

  // lifecycle
  reference_count: number;
  importance: number;
  expires_at?: ISO8601;
}

export interface Decision extends ReasoningBase {
  type: 'decision';
  question: string;
  answer: string;
  alternatives_rejected: Alternative[];
  implications: string[];
  reversibility: 'easy' | 'medium' | 'hard' | 'irreversible';
  supersedes?: string;
}

export interface Observation extends ReasoningBase {
  type: 'observation';
}

export interface Hypothesis extends ReasoningBase {
  type: 'hypothesis';
}

export interface Risk extends ReasoningBase {
  type: 'risk';
  risk_description: string;
  likelihood: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high' | 'critical';
  mitigation_strategy?: string;
  monitoring_approach?: string;
  status: 'open' | 'mitigated' | 'accepted' | 'realized';
}

export interface Assumption extends ReasoningBase {
  type: 'assumption';
}

export interface ConstraintReasoning extends ReasoningBase {
  type: 'constraint';
}

export interface Thinking extends ReasoningBase {
  type: 'thinking';
}

export type ReasoningObject =
  | Decision
  | Observation
  | Hypothesis
  | Risk
  | Assumption
  | ConstraintReasoning
  | Thinking;

export interface FailureRecord {
  id: string;
  session_id: string;
  task_id: string;
  approach_attempted: string;
  why_it_failed: string;
  evidence_of_failure: string[];
  alternatives_suggested: string[];
  affected_files: FileRef[];
  confidence_in_failure_diagnosis: number;
  created_at: ISO8601;
  permanent: boolean;
}
