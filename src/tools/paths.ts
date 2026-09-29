import fs from "node:fs";
import path from "node:path";

/**
 * Workspace path guard.
 *
 * This is NOT a sandbox: it is a boundary check layered under the permission
 * dialog. Every path-taking tool resolves user/model-supplied paths through
 * `resolveWorkspacePath` before touching the filesystem.
 *
 * Escape route we close: a symlink inside the project pointing outside
 * (`link -> /etc/hosts`, or a symlinked directory). Lexical containment
 * (`startsWith(root)`) cannot see that, so we canonicalize BOTH sides with
 * `fs.realpathSync` — the target (or its nearest existing ancestor for files
 * that do not exist yet) and the project root — and compare the real paths.
 */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/** The nearest ancestor of `p` that exists (including `p` itself). */
function nearestExisting(p: string): string {
  let current = path.resolve(p);
  // Bound the walk: root always exists, so this terminates.
  for (;;) {
    try {
      fs.statSync(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolve `target` (absolute or relative to `projectRoot`) to an absolute
 * path that is provably inside the project after symlink resolution.
 *
 * Throws `WorkspacePathError` with a model-friendly message when the path
 * escapes the workspace.
 */
export function resolveWorkspacePath(projectRoot: string, target: string): string {
  const root = path.resolve(projectRoot);
  const lexical = path.resolve(root, target);

  // Canonicalize the project root once; if the root itself sits behind a
  // symlink (common on Windows temp dirs / macOS /tmp), both sides must use
  // the same spelling for containment to hold.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // Project root missing entirely: nothing can be inside it.
    throw new WorkspacePathError(`Project directory does not exist: ${root}`);
  }

  // Canonicalize the target. For a path that exists, realpath resolves the
  // full chain; for a new file, resolve the nearest existing ancestor (the
  // directory it will be created in) and re-append the remaining segments.
  let realTarget: string;
  const existing = nearestExisting(lexical);
  try {
    const realExisting = fs.realpathSync(existing);
    realTarget = realExisting + lexical.slice(existing.length);
  } catch {
    realTarget = lexical;
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new WorkspacePathError(
      `Path resolves outside project directory: ${target} -> ${realTarget}`,
    );
  }

  // Return the lexical path (predictable for display and for I/O on new
  // files); callers only ever receive paths that passed the real check.
  return lexical;
}

/** True when `candidate` is the project root or inside it (post-realpath). */
export function isInsideWorkspace(projectRoot: string, candidate: string): boolean {
  try {
    resolveWorkspacePath(projectRoot, candidate);
    return true;
  } catch {
    return false;
  }
}

/** Render a path relative to the project root for display; absolute if outside.
 * Always uses forward slashes — tool output is read by the model, and stable
 * separators keep transcripts platform-independent. */
export function toRelative(projectRoot: string, target: string): string {
  const rel = path.relative(path.resolve(projectRoot), path.resolve(target));
  if (rel === "") return ".";
  if (rel.startsWith("..")) return path.resolve(target).split(path.sep).join("/");
  return rel.split(path.sep).join("/");
}
