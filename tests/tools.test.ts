import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  ToolRegistry,
  WorkspacePathError,
  resolveWorkspacePath,
} from "../src/tools/index.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-tools-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("path guard (double realpath)", () => {
  it("accepts a plain relative path inside the project", () => {
    const p = resolveWorkspacePath(root, "src/a.ts");
    expect(p).toBe(path.join(root, "src/a.ts"));
  });

  it("accepts the project root itself", () => {
    expect(resolveWorkspacePath(root, ".")).toBe(root);
  });

  it("rejects a symlink pointing outside the project", (ctx) => {
    const outside = path.join(os.tmpdir(), `tinycode-outside-${Date.now()}`);
    fs.writeFileSync(outside, "secret");
    const link = path.join(root, "escape.txt");
    try {
      fs.symlinkSync(outside, link);
    } catch {
      // Windows without developer mode / admin can't create symlinks.
      ctx.skip();
      return;
    }
    expect(() => resolveWorkspacePath(root, "escape.txt")).toThrow(WorkspacePathError);
    fs.rmSync(outside, { force: true });
  });

  it("rejects a path that lexically stays inside but escapes via symlinked dir", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-od-"));
    fs.writeFileSync(path.join(outsideDir, "x.txt"), "x");
    const link = path.join(root, "vendor");
    try {
      fs.symlinkSync(outsideDir, link, "junction");
    } catch {
      return; // platform without symlink support
    }
    expect(() => resolveWorkspacePath(root, "vendor/x.txt")).toThrow(WorkspacePathError);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects absolute paths outside the project", () => {
    // Platform-neutral: `path.parse(root).root` is `C:\` on Windows and `/`
    // on POSIX, so this is an absolute path outside the project on both.
    const outside = path.join(path.parse(root).root, "tinycode-outside-probe.txt");
    expect(path.isAbsolute(outside)).toBe(true);
    expect(() => resolveWorkspacePath(root, outside)).toThrow(WorkspacePathError);
  });

  it("allows a new (not yet existing) file inside the project", () => {
    const p = resolveWorkspacePath(root, "new/dir/file.txt");
    expect(p).toBe(path.join(root, "new", "dir", "file.txt"));
  });
});

describe("read tool", () => {
  it("numbers lines and honors offset/limit windows", async () => {
    const file = path.join(root, "numbered.txt");
    fs.writeFileSync(file, ["a", "b", "c", "d", "e"].join("\n"));
    const tool = createReadTool(root);

    const all = await tool.execute("t1", { path: "numbered.txt" });
    expect(all.content[0]!.type).toBe("text");
    const text = (all.content[0] as { text: string }).text;
    expect(text).toContain("1→ a");
    expect(text).toContain("5→ e");
    expect(all.details).toMatchObject({ totalLines: 5, startLine: 1, endLine: 5 });

    const win = await tool.execute("t2", { path: "numbered.txt", offset: 2, limit: 2 });
    const winText = (win.content[0] as { text: string }).text;
    expect(winText).toContain("2→ b");
    expect(winText).toContain("3→ c");
    expect(winText).not.toContain("4→ d");
    expect(win.details).toMatchObject({ startLine: 2, endLine: 3, truncated: true });
  });

  it("reports a friendly error for missing files", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute("t", { path: "nope.txt" })).rejects.toThrow(/File not found/);
  });

  it("refuses directories with a hint to use ls", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute("t", { path: "." })).rejects.toThrow(/use ls/);
  });

  it("refuses binary files", async () => {
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 0, 255]));
    const tool = createReadTool(root);
    await expect(tool.execute("t", { path: "bin.dat" })).rejects.toThrow(/Binary/);
  });

  it("cannot read outside the workspace through a symlink", async () => {
    const outside = path.join(os.tmpdir(), `tinycode-rd-${Date.now()}.txt`);
    fs.writeFileSync(outside, "classified");
    const link = path.join(root, "leak.txt");
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return;
    }
    const tool = createReadTool(root);
    await expect(tool.execute("t", { path: "leak.txt" })).rejects.toThrow(
      /outside project directory/,
    );
    fs.rmSync(outside, { force: true });
  });
});

describe("write tool", () => {
  it("creates parent directories and reports creation", async () => {
    const tool = createWriteTool(root);
    const res = await tool.execute("t", { path: "deep/nested/a.txt", content: "hello\n" });
    expect(fs.readFileSync(path.join(root, "deep", "nested", "a.txt"), "utf8")).toBe("hello\n");
    expect(res.details).toMatchObject({ created: true });
  });

  it("reports +a -d against previous content on overwrite", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "one\ntwo\nthree\n");
    const tool = createWriteTool(root);
    const res = await tool.execute("t", { path: "f.txt", content: "one\nTWO\nthree\nfour\n" });
    expect(res.details).toMatchObject({ created: false, added: 2, removed: 1 });
  });

  it("refuses to write outside the workspace", async () => {
    const tool = createWriteTool(root);
    await expect(tool.execute("t", { path: "../escape.txt", content: "x" })).rejects.toThrow(
      /outside project directory/,
    );
  });
});

describe("edit tool", () => {
  it("replaces an exact unique match and returns a diff", async () => {
    fs.writeFileSync(path.join(root, "m.ts"), "const a = 1;\nconst b = 2;\n");
    const tool = createEditTool(root);
    const res = await tool.execute("t", {
      path: "m.ts",
      oldText: "const b = 2;",
      newText: "const b = 20;",
    });
    expect(fs.readFileSync(path.join(root, "m.ts"), "utf8")).toBe("const a = 1;\nconst b = 20;\n");
    expect(res.details).toMatchObject({ matches: 1 });
    expect((res.details as { diff: string }).diff).toContain("+const b = 20;");
    expect((res.details as { diff: string }).diff).toContain("-const b = 2;");
  });

  it("fails on 0 matches with a copy-exactly hint", async () => {
    fs.writeFileSync(path.join(root, "m.ts"), "abc\n");
    const tool = createEditTool(root);
    await expect(tool.execute("t", { path: "m.ts", oldText: "xyz", newText: "q" })).rejects.toThrow(
      /not found[\s\S]*exactly/,
    );
  });

  it("fails on multiple matches unless replaceAll", async () => {
    fs.writeFileSync(path.join(root, "m.ts"), "x\nx\nx\n");
    const tool = createEditTool(root);
    await expect(tool.execute("t", { path: "m.ts", oldText: "x", newText: "y" })).rejects.toThrow(
      /matches 3 times/,
    );

    const res = await tool.execute("t", {
      path: "m.ts",
      oldText: "x",
      newText: "y",
      replaceAll: true,
    });
    expect(fs.readFileSync(path.join(root, "m.ts"), "utf8")).toBe("y\ny\ny\n");
    expect(res.details).toMatchObject({ matches: 3 });
  });

  it("reports missing files with a write hint", async () => {
    const tool = createEditTool(root);
    await expect(
      tool.execute("t", { path: "ghost.ts", oldText: "a", newText: "b" }),
    ).rejects.toThrow(/use write/);
  });
});

describe("bash tool", () => {
  it("returns stdout, exit code and duration (non-zero exit is data)", async () => {
    const tool = createBashTool(root);
    const res = await tool.execute("t", {
      command: "node -e \"console.log('hi'); process.exit(3)\"",
    });
    const details = res.details as { exitCode: number | null; durationMs: number };
    expect(details.exitCode).toBe(3);
    expect((res.content[0] as { text: string }).text).toContain("hi");
    expect(details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr separately", async () => {
    const tool = createBashTool(root);
    const res = await tool.execute("t", {
      command: "node -e \"console.error('bad thing')\"",
    });
    expect((res.content[0] as { text: string }).text).toContain("bad thing");
    expect((res.content[0] as { text: string }).text).toContain("stderr");
  });

  it("times out a hanging command", async () => {
    const tool = createBashTool(root);
    await expect(
      tool.execute("t", { command: 'node -e "setTimeout(()=>{},30000)"', timeout: 500 }),
    ).rejects.toThrow(/timed out/);
  });

  it("honors an abort signal", async () => {
    const tool = createBashTool(root);
    const controller = new AbortController();
    const promise = tool.execute(
      "t",
      { command: 'node -e "setTimeout(()=>{},30000)"', timeout: 30_000 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    await expect(promise).rejects.toThrow(/abort/i);
  });

  it("caps huge output head+tail", async () => {
    const tool = createBashTool(root);
    const res = await tool.execute("t", {
      command: "node -e \"for(let i=0;i<40000;i++) console.log('line '+i)\"",
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(200_000);
    expect(res.details).toMatchObject({ truncated: true });
    expect(text).toContain("line 0");
  });
});

describe("grep tool", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const target = 1;\nexport {};\n");
    fs.writeFileSync(path.join(root, "src", "b.js"), "let target = 2;\n");
    fs.writeFileSync(path.join(root, "README.md"), "target in docs\n");
  });

  it("finds matches across files with file:line format", async () => {
    const tool = createGrepTool(root);
    const res = await tool.execute("t", { pattern: "target" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("src/a.ts:1:");
    expect(text).toContain("src/b.js:1:");
    expect(res.details).toMatchObject({ matches: 3, files: 3 });
  });

  it("filters by include glob", async () => {
    const tool = createGrepTool(root);
    const res = await tool.execute("t", { pattern: "target", include: "*.ts" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("src/b.js");
    expect(res.details).toMatchObject({ matches: 1, files: 1 });
  });

  it("reports no matches explicitly", async () => {
    const tool = createGrepTool(root);
    const res = await tool.execute("t", { pattern: "zzz_not_here" });
    expect((res.content[0] as { text: string }).text).toMatch(/^No matches/);
  });

  it("rejects invalid regex with a readable message", async () => {
    const tool = createGrepTool(root);
    await expect(tool.execute("t", { pattern: "([unclosed" })).rejects.toThrow(
      /Invalid regular expression/,
    );
  });

  it("skips node_modules", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "x.ts"), "target");
    const tool = createGrepTool(root);
    const res = await tool.execute("t", { pattern: "target" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain("node_modules");
  });
});

describe("find tool", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "");
    fs.writeFileSync(path.join(root, "src", "deep", "b.ts"), "");
    fs.writeFileSync(path.join(root, "package.json"), "{}");
  });

  it("** crosses directories and results are sorted", async () => {
    const tool = createFindTool(root);
    const res = await tool.execute("t", { pattern: "**/*.ts" });
    const lines = (res.content[0] as { text: string }).text.split("\n").slice(1);
    expect(lines).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  it("single star does not cross directories", async () => {
    const tool = createFindTool(root);
    const res = await tool.execute("t", { pattern: "src/*.ts" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("src/deep/b.ts");
  });

  it("finds a literal file name at the root", async () => {
    const tool = createFindTool(root);
    const res = await tool.execute("t", { pattern: "package.json" });
    expect((res.content[0] as { text: string }).text).toContain("package.json");
  });
});

describe("ls tool", () => {
  it("lists dirs first with sizes", async () => {
    fs.mkdirSync(path.join(root, "adir"));
    fs.writeFileSync(path.join(root, "b.txt"), "hello world");
    const tool = createLsTool(root);
    const res = await tool.execute("t", {});
    const details = res.details as { entries: Array<{ name: string; type: string }> };
    expect(details.entries[0]!.name).toBe("adir");
    expect(details.entries[0]!.type).toBe("dir");
    expect(details.entries[1]!.name).toBe("b.txt");
    expect((res.content[0] as { text: string }).text).toContain("adir/");
  });

  it("errors on a missing directory", async () => {
    const tool = createLsTool(root);
    await expect(tool.execute("t", { path: "ghost" })).rejects.toThrow(/not found/);
  });
});

describe("tool registry", () => {
  it("exposes one uniform surface", () => {
    const registry = new ToolRegistry();
    registry.register(createReadTool(root));
    registry.register(createBashTool(root));
    expect(registry.names()).toEqual(["read", "bash"]);
    expect(registry.get("read")?.label).toBe("Read file");
    expect(registry.size).toBe(2);
  });

  it("rejects duplicate names loudly", () => {
    const registry = new ToolRegistry();
    registry.register(createReadTool(root));
    expect(() => registry.register(createReadTool(root))).toThrow(/already registered/);
  });

  it("registerIfAbsent keeps the first winner", () => {
    const registry = new ToolRegistry();
    expect(registry.registerIfAbsent(createReadTool(root))).toBe(true);
    expect(registry.registerIfAbsent(createReadTool(root))).toBe(false);
    expect(registry.size).toBe(1);
  });
});
