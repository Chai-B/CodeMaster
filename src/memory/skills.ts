// Procedural skills extraction and Markdown vault sync (spec §7, EverOS dual-track).
// Extracts reusable procedural recipes from verified task completions and persists
// them as human-editable Markdown documents in .codemaster/memory/skills/.

import fs from 'fs';
import path from 'path';
import { getDb } from '../storage/db.js';
import { id, now } from '../util/id.js';
import type { Task, IntermediateRepresentation } from '../types/index.js';

export interface ProceduralSkill {
  id: string;
  name: string;
  task_type: string;
  repository_pattern?: string;
  description?: string;
  steps: string[];
  success_count: number;
  last_verified_at: string;
  created_at: string;
}

function skillsDir(repoPath: string): string {
  const dir = path.join(repoPath, '.codemaster', 'memory', 'skills');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64) || 'unnamed_skill';
}

export function renderSkillMarkdown(skill: ProceduralSkill): string {
  const stepsList = skill.steps.map((s, idx) => `${idx + 1}. ${s}`).join('\n');
  return `---
id: "${skill.id}"
name: "${skill.name}"
task_type: "${skill.task_type}"
success_count: ${skill.success_count}
last_verified_at: "${skill.last_verified_at}"
created_at: "${skill.created_at}"
---

# ${skill.name}

${skill.description || 'Procedural skill generated from verified task completion.'}

## Steps
${stepsList || '1. Perform task implementation.'}
`;
}

export function parseSkillMarkdown(content: string): Partial<ProceduralSkill> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content.trim());
  if (!match) return null;

  const frontmatter = match[1]!;
  const body = match[2]!.trim();

  const getAttr = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?`, 'm').exec(frontmatter);
    return m?.[1]?.trim();
  };

  const name = getAttr('name');
  const task_type = getAttr('task_type') || 'general';
  const idStr = getAttr('id') || id('skill');
  const successCount = parseInt(getAttr('success_count') || '1', 10);
  const lastVerified = getAttr('last_verified_at') || now();
  const createdAt = getAttr('created_at') || now();

  // Extract steps from ## Steps
  const steps: string[] = [];
  const stepsSection = body.split(/##\s+Steps/i)[1];
  if (stepsSection) {
    const stepLines = stepsSection.split('\n');
    for (const line of stepLines) {
      const trimmed = line.trim();
      if (/^\d+\.\s+/.test(trimmed)) {
        steps.push(trimmed.replace(/^\d+\.\s+/, ''));
      } else if (trimmed.startsWith('##')) {
        break; // next heading
      }
    }
  }

  // Extract description (text before ## Steps)
  const descMatch = /^#\s+[^\n]+\n+([\s\S]*?)(?:##\s+Steps|$)/.exec(body);
  const description = descMatch?.[1]?.trim();

  if (!name) return null;

  return {
    id: idStr,
    name,
    task_type,
    description,
    steps: steps.length > 0 ? steps : ['Perform task implementation.'],
    success_count: isNaN(successCount) ? 1 : successCount,
    last_verified_at: lastVerified,
    created_at: createdAt,
  };
}

export const Skills = {
  get(repoPath: string, name: string): ProceduralSkill | null {
    const db = getDb(repoPath);
    const row = db
      .prepare('SELECT * FROM procedural_skills WHERE name=?')
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      task_type: row.task_type as string,
      repository_pattern: (row.repository_pattern as string) ?? undefined,
      description: (row.description as string) ?? undefined,
      steps: JSON.parse((row.steps_json as string) || '[]'),
      success_count: row.success_count as number,
      last_verified_at: row.last_verified_at as string,
      created_at: row.created_at as string,
    };
  },

  list(repoPath: string, taskType?: string): ProceduralSkill[] {
    const db = getDb(repoPath);
    const rows = taskType
      ? (db
          .prepare('SELECT * FROM procedural_skills WHERE task_type=? ORDER BY success_count DESC')
          .all(taskType) as Record<string, unknown>[])
      : (db
          .prepare('SELECT * FROM procedural_skills ORDER BY success_count DESC')
          .all() as Record<string, unknown>[]);

    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      task_type: r.task_type as string,
      repository_pattern: (r.repository_pattern as string) ?? undefined,
      description: (r.description as string) ?? undefined,
      steps: JSON.parse((r.steps_json as string) || '[]'),
      success_count: r.success_count as number,
      last_verified_at: r.last_verified_at as string,
      created_at: r.created_at as string,
    }));
  },

  findRelevant(repoPath: string, taskType?: string, query?: string, limit = 4): ProceduralSkill[] {
    const all = Skills.list(repoPath, taskType);
    if (!query || !query.trim()) return all.slice(0, limit);
    const qTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const scored = all.map((skill) => {
      let score = skill.success_count;
      const text = `${skill.name} ${skill.description ?? ''} ${skill.steps.join(' ')}`.toLowerCase();
      for (const tok of qTokens) {
        if (text.includes(tok)) score += 5;
      }
      return { skill, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.skill);
  },

  upsert(repoPath: string, skill: ProceduralSkill): void {
    const db = getDb(repoPath);
    db.prepare(
      `INSERT INTO procedural_skills
       (id, name, task_type, repository_pattern, description, steps_json, success_count, last_verified_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         steps_json=excluded.steps_json,
         description=excluded.description,
         success_count=excluded.success_count,
         last_verified_at=excluded.last_verified_at`,
    ).run(
      skill.id,
      skill.name,
      skill.task_type,
      skill.repository_pattern ?? null,
      skill.description ?? null,
      JSON.stringify(skill.steps),
      skill.success_count,
      skill.last_verified_at,
      skill.created_at,
    );

    // Mirror to Markdown vault
    try {
      const dir = skillsDir(repoPath);
      const filePath = path.join(dir, `${sanitizeName(skill.name)}.md`);
      fs.writeFileSync(filePath, renderSkillMarkdown(skill), 'utf8');
    } catch {
      /* disk write is best-effort */
    }
  },

  recordTaskSuccess(
    repoPath: string,
    task: Task,
    ir: IntermediateRepresentation,
    changedFiles: string[],
  ): ProceduralSkill | null {
    if (!changedFiles || changedFiles.length === 0) return null;

    const skillName = sanitizeName(task.title);
    const existing = Skills.get(repoPath, skillName);

    const steps: string[] = [];
    if (changedFiles.length > 0) {
      steps.push(`Target working files: ${changedFiles.slice(0, 5).join(', ')}`);
    }
    for (const d of ir.decisions ?? []) {
      if (d.summary && d.summary !== 'decision') {
        steps.push(d.summary);
      }
    }
    if (steps.length === 0) {
      steps.push(`Apply verified changes for task '${task.title}'`);
    }

    const current: ProceduralSkill = {
      id: existing ? existing.id : id('skill'),
      name: skillName,
      task_type: task.type || 'general',
      description: task.description || ir.summary || undefined,
      steps,
      success_count: existing ? existing.success_count + 1 : 1,
      last_verified_at: now(),
      created_at: existing ? existing.created_at : now(),
    };

    Skills.upsert(repoPath, current);
    return current;
  },

  syncFromDisk(repoPath: string): number {
    const dir = path.join(repoPath, '.codemaster', 'memory', 'skills');
    if (!fs.existsSync(dir)) return 0;

    let synced = 0;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const parsed = parseSkillMarkdown(content);
        if (parsed && parsed.name) {
          const fullSkill: ProceduralSkill = {
            id: parsed.id || id('skill'),
            name: parsed.name,
            task_type: parsed.task_type || 'general',
            description: parsed.description,
            steps: parsed.steps || [],
            success_count: parsed.success_count ?? 1,
            last_verified_at: parsed.last_verified_at || now(),
            created_at: parsed.created_at || now(),
          };
          const db = getDb(repoPath);
          db.prepare(
            `INSERT INTO procedural_skills
             (id, name, task_type, repository_pattern, description, steps_json, success_count, last_verified_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(name) DO UPDATE SET
               steps_json=excluded.steps_json,
               description=excluded.description,
               success_count=excluded.success_count,
               last_verified_at=excluded.last_verified_at`,
          ).run(
            fullSkill.id,
            fullSkill.name,
            fullSkill.task_type,
            null,
            fullSkill.description ?? null,
            JSON.stringify(fullSkill.steps),
            fullSkill.success_count,
            fullSkill.last_verified_at,
            fullSkill.created_at,
          );
          synced++;
        }
      } catch {
        /* skip invalid markdown files */
      }
    }
    return synced;
  },
};
