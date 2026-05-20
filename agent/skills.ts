import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const ACCEPTED_EXTS = new Set(['.md', '.markdown', '.txt']);
const skills = new Map<string, string>();

function skillsDir(): string {
  return resolve(process.env.MUSTER_SKILLS_DIR || './skills');
}

export function loadSkills(): void {
  skills.clear();
  const dir = skillsDir();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[muster] could not read skills directory ${dir}:`, err);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!ACCEPTED_EXTS.has(ext)) continue;
    const name = basename(entry.name, ext);
    try {
      skills.set(name, readFileSync(join(dir, entry.name), 'utf8'));
    } catch (err) {
      console.error(`[muster] failed to read skill ${entry.name}:`, err);
    }
  }
  console.log(`[muster] loaded ${skills.size} skill(s) from ${dir}: ${[...skills.keys()].join(', ') || '(none)'}`);
}

export type Skill = { name: string; content: string };

export function listSkills(): Skill[] {
  return [...skills.entries()]
    .map(([name, content]) => ({ name, content }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): string | undefined {
  return skills.get(name);
}

function firstNonEmptyLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line;
  }
  return '';
}

export function renderInstructions(): string {
  const all = listSkills();
  const list = all.length
    ? all.map((s) => `- \`${s.name}\` — ${firstNonEmptyLine(s.content) || '(no description)'}`).join('\n')
    : '- (no skills bundled — add markdown files under /skills)';

  return `You are Muster, a dispatcher agent. Your only job is to route user requests to the right "skill" and follow that skill's instructions to answer.

Available skills:
${list}

How to handle a request:
1. Pick the skill whose description best matches the user's request.
2. Call the \`run_skill\` tool with that skill's name to load its instructions.
3. Follow the returned skill instructions exactly to produce your answer.
4. If no skill clearly applies, say so plainly and list the available skill names — do not improvise.

If the user begins a message with \`/<skill-name>\`, that is an explicit dispatch. The skill content has already been injected into the prompt for you — apply it directly without calling \`run_skill\`.`;
}

export const runSkillTool = createTool({
  id: 'run_skill',
  description:
    'Load the markdown instructions for a named skill so you can follow them. Call this once per turn after you pick which skill best matches the user request.',
  inputSchema: z.object({
    skill_name: z.string().describe('Exact name of the skill to load (case-sensitive, no extension).'),
  }),
  execute: async ({ context }) => {
    const content = getSkill(context.skill_name);
    if (!content) {
      const available = listSkills().map((s) => s.name).join(', ') || '(none)';
      return { ok: false, error: `Skill "${context.skill_name}" not found. Available skills: ${available}.` };
    }
    return { ok: true, skill_name: context.skill_name, instructions: content };
  },
});

/**
 * If `prompt` starts with `/<skill-name>`, return a rewritten prompt that
 * inlines the skill content and tells the LLM to apply it directly. Returns
 * `null` if no slash dispatch was requested.
 */
export function rewriteSlashDispatch(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const match = trimmed.match(/^\/([A-Za-z0-9_.-]+)\s*([\s\S]*)$/);
  if (!match) return null;

  const skillName = match[1];
  const rest = match[2] ?? '';
  const content = getSkill(skillName);

  if (!content) {
    const available = listSkills().map((s) => s.name).join(', ') || '(none)';
    return `The user invoked the skill \`/${skillName}\` but no such skill is bundled. Tell them: "Unknown skill: ${skillName}. Available skills: ${available}." Do not call any tools.`;
  }

  return `The user explicitly invoked the \`${skillName}\` skill with this input:

${rest.trim() || '(no additional input)'}

The skill's instructions are below. Apply them exactly to the user's input. Do not call \`run_skill\` — the skill is already loaded.

--- begin ${skillName} skill ---
${content}
--- end ${skillName} skill ---`;
}
