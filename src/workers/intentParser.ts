// IntentParser — deterministic objective → structured task (spec §12.2, never LLM).

import { keywords } from '../util/tokens.js';
import type { ParsedObjective, TaskType } from '../types/index.js';

const TYPE_SIGNALS: Array<[TaskType, RegExp]> = [
  ['debug', /\b(fix|bug|debug|broken|error|crash|fails?|failing|regression)\b/i],
  ['test', /\b(test|tests|coverage|spec|unit test|integration test)\b/i],
  ['refactor', /\b(refactor|clean ?up|restructure|rename|extract|simplif|reorganiz)\b/i],
  ['review', /\b(review|audit|inspect|check)\b/i],
  ['verify', /\b(verify|validate|confirm)\b/i],
  ['implement', /\b(implement|add|create|build|write|generate|introduce|support)\b/i],
];

const FILE_RE = /\b([\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|h|hpp|swift|json|yaml|yml|md|sql))\b/g;

export function parseObjective(text: string): ParsedObjective {
  let taskType: TaskType = 'implement';
  for (const [type, re] of TYPE_SIGNALS) {
    if (re.test(text)) {
      taskType = type;
      break;
    }
  }

  const scope: string[] = [];
  for (let m; (m = FILE_RE.exec(text)); ) scope.push(m[1]!);

  const constraints: string[] = [];
  const constraintRe = /\b(?:must|should not|don'?t|without|only|never|always|keep|avoid)\b[^.,;]*/gi;
  for (let m; (m = constraintRe.exec(text)); ) constraints.push(m[0]!.trim());

  return {
    goal: text.trim(),
    scope: [...new Set(scope)],
    constraints,
    keywords: keywords(text),
    task_type: taskType,
  };
}
