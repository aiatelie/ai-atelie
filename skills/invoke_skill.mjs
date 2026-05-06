/* invoke_skill.mjs — model-agnostic skill loader.
 *
 * Mirrors Anthropic's `invoke_skill({ name })` contract: takes a skill name,
 * returns the SKILL.md body so the caller can inject it into the model's
 * context.
 *
 * Two consumers:
 *   - Claude Code: doesn't need this — it picks up `.claude/skills/` natively.
 *   - Anything else (Kimi K2, OpenAI, custom harness): expose this as a tool
 *     to the model and inject `index.json` into the system prompt as the menu.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * @returns {Promise<{name: string, display: string, description: string, body_status: string}[]>}
 */
export async function listSkills() {
  const idx = JSON.parse(await readFile(resolve(SKILLS_DIR, "index.json"), "utf8"));
  return idx.skills;
}

/**
 * @param {string} name — kebab-case skill name (e.g. "make-tweakable")
 * @returns {Promise<string>} — full SKILL.md body
 */
export async function invokeSkill(name) {
  const safe = String(name).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!safe) throw new Error(`invoke_skill: invalid name "${name}"`);
  try {
    return await readFile(resolve(SKILLS_DIR, safe, "SKILL.md"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      const known = (await listSkills()).map((s) => s.name).join(", ");
      throw new Error(`invoke_skill: unknown skill "${name}". Known: ${known}`);
    }
    throw err;
  }
}

/** Tool schema for OpenAI/Kimi-style function calling. */
export const invokeSkillToolSchema = {
  type: "function",
  function: {
    name: "invoke_skill",
    description:
      "Invoke a built-in skill by name. Returns the skill's full prompt so you can follow its instructions. Use this when the user asks for something that matches a skill you know about but whose prompt is not already in context.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'The skill name (kebab-case), e.g. "frontend-design", "make-tweakable", "interactive-prototype".',
        },
      },
      required: ["name"],
    },
  },
};

/** Builds the menu text to inject into a system prompt. */
export async function buildSkillMenuText() {
  const skills = await listSkills();
  const lines = [
    "## Available Skills",
    "",
    "You have the following built-in skills. If the user asks for something that matches one of these and the skill's prompt is not already in your context, call the `invoke_skill` tool with the skill name to load its instructions.",
    "",
    ...skills.map((s) => `- **${s.display}** (\`${s.name}\`) — ${s.description}`),
  ];
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [, , cmd, arg] = process.argv;
  if (cmd === "list") {
    console.log(JSON.stringify(await listSkills(), null, 2));
  } else if (cmd === "menu") {
    console.log(await buildSkillMenuText());
  } else if (cmd === "get" && arg) {
    process.stdout.write(await invokeSkill(arg));
  } else {
    console.error("usage: invoke_skill.mjs <list|menu|get <name>>");
    process.exit(1);
  }
}
