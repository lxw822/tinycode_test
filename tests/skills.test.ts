import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  discoverSkills,
  parseSkillFile,
  skillIndex,
  projectSkillsDir,
  userSkillsDir,
} from "../src/skills/discovery.js";
import { createLoadSkillTool } from "../src/tools/load-skill.js";
import { evaluateToolCall } from "../src/permissions/rules.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-skills-"));
let projectRoot: string;
let home: string;

function writeSkill(base: string, dir: string, file: string, content: string): void {
  const target = path.join(base, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, file), content);
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(tmp, "proj-"));
  home = fs.mkdtempSync(path.join(tmp, "home-"));
  process.env["TINYCODE_HOME"] = home;
});

afterAll(() => {
  delete process.env["TINYCODE_HOME"];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE = `---
name: code-review
description: Review code changes for correctness.
---
# instructions
Check edge cases first.
`;

describe("skill discovery", () => {
  it("reads project-level SKILL.md frontmatter", () => {
    writeSkill(projectRoot, path.join(".tinycode", "skills", "code-review"), "SKILL.md", SAMPLE);
    const skills = discoverSkills(projectRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("code-review");
    expect(skills[0]!.description).toBe("Review code changes for correctness.");
    expect(skills[0]!.scope).toBe("project");
  });

  it("keeps only name and description in the index (body never reaches the prompt)", () => {
    writeSkill(projectRoot, path.join(".tinycode", "skills", "code-review"), "SKILL.md", SAMPLE);
    const index = skillIndex(discoverSkills(projectRoot))!;
    expect(index).toBe("- code-review: Review code changes for correctness.");
    expect(index).not.toContain("Check edge cases first.");
    expect(index).not.toContain("instructions");
  });

  it("falls back to the directory name and first heading", () => {
    writeSkill(
      projectRoot,
      path.join(".tinycode", "skills", "my-skill"),
      "SKILL.md",
      "# Do things\n",
    );
    const [skill] = discoverSkills(projectRoot);
    expect(skill!.name).toBe("my-skill");
    expect(skill!.description).toBe("Do things");
  });

  it("discovers user-level skills from the data home", () => {
    writeSkill(
      userSkillsDir(),
      "user-note",
      "SKILL.md",
      "---\ndescription: A user skill\n---\nbody\n",
    );
    const skills = discoverSkills(projectRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.scope).toBe("user");
    expect(skills[0]!.description).toBe("A user skill");
  });

  it("lets a project skill shadow a same-named user skill", () => {
    writeSkill(userSkillsDir(), "dup", "SKILL.md", "---\nname: dup\ndescription: user copy\n---\n");
    writeSkill(
      projectRoot,
      path.join(".tinycode", "skills", "dup"),
      "SKILL.md",
      "---\nname: dup\ndescription: project copy\n---\n",
    );
    const skills = discoverSkills(projectRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe("project copy");
    expect(skills[0]!.scope).toBe("project");
  });

  it("returns an empty index when nothing is installed", () => {
    expect(discoverSkills(projectRoot)).toEqual([]);
    expect(skillIndex([])).toBeUndefined();
  });

  it("sorts skills by name for a stable prompt", () => {
    writeSkill(projectRoot, path.join(".tinycode", "skills", "zeta"), "SKILL.md", "# Z\n");
    writeSkill(projectRoot, path.join(".tinycode", "skills", "alpha"), "SKILL.md", "# A\n");
    expect(discoverSkills(projectRoot).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("survives malformed files instead of breaking boot", () => {
    // Unterminated frontmatter, empty file, and a stray non-directory entry.
    writeSkill(
      projectRoot,
      path.join(".tinycode", "skills", "broken"),
      "SKILL.md",
      "---\nname: broken\nno closing fence\n",
    );
    writeSkill(projectRoot, path.join(".tinycode", "skills", "empty"), "SKILL.md", "");
    fs.writeFileSync(path.join(projectSkillsDir(projectRoot), "loose.md"), "ignored");
    const skills = discoverSkills(projectRoot);
    expect(skills.map((s) => s.name)).toContain("broken");
    expect(skills.map((s) => s.name)).toContain("empty");
    expect(skills.map((s) => s.name)).not.toContain("loose");
  });

  it("treats a missing skills directory as no skills", () => {
    expect(discoverSkills(projectRoot)).toEqual([]);
    expect(parseSkillFile(path.join(tmp, "does-not-exist", "SKILL.md"), "user")).toBeUndefined();
  });
});

describe("load_skill tool", () => {
  it("returns the full body with frontmatter stripped", async () => {
    writeSkill(projectRoot, path.join(".tinycode", "skills", "code-review"), "SKILL.md", SAMPLE);
    const tool = createLoadSkillTool(discoverSkills(projectRoot));
    const result = await tool.execute!("call-1", { name: "code-review" });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("# code-review");
    expect(text).toContain("Check edge cases first.");
    expect(text).not.toContain("name: code-review");
    expect((result.details as { bytes: number }).bytes).toBeGreaterThan(0);
  });

  it("rejects unknown names with the available list", async () => {
    writeSkill(projectRoot, path.join(".tinycode", "skills", "known"), "SKILL.md", "# K\n");
    const tool = createLoadSkillTool(discoverSkills(projectRoot));
    await expect(tool.execute!("call-1", { name: "nope" })).rejects.toThrow(
      /Unknown skill: nope.*known/,
    );
  });

  it("cannot traverse: path-like names never resolve", async () => {
    writeSkill(projectRoot, path.join(".tinycode", "skills", "known"), "SKILL.md", "# K\n");
    const tool = createLoadSkillTool(discoverSkills(projectRoot));
    for (const name of ["../../etc/passwd", "..\\..\\secret", "/etc/passwd"]) {
      await expect(tool.execute!("call-1", { name })).rejects.toThrow(/Unknown skill/);
    }
  });

  it("reports an unreadable skill file cleanly", async () => {
    const skills = [
      { name: "ghost", description: "d", file: path.join(tmp, "gone.md"), scope: "user" as const },
    ];
    const tool = createLoadSkillTool(skills);
    await expect(tool.execute!("call-1", { name: "ghost" })).rejects.toThrow(/unreadable/);
  });
});

describe("load_skill permission", () => {
  it("auto-allows (name-only, read-only)", () => {
    expect(evaluateToolCall("load_skill", { name: "code-review" }, projectRoot)).toMatchObject({
      action: "allow",
      risk: "safe",
    });
  });
});
