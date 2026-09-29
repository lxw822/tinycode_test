import { spawn } from "node:child_process";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath } from "./paths.js";

const BashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 600_000, description: "Timeout in ms (default 120000)" }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory, relative to the project root" }),
  ),
});

export type BashParams = Static<typeof BashParams>;

export interface BashToolDetails {
  command: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap captured output: keep head + tail so neither the start nor the error is lost. */
const OUTPUT_CAP = 100_000;
const HEAD_SHARE = 0.6;

/**
 * Kill a spawned shell AND its descendants.
 *
 * On Windows `child.kill()` only terminates the cmd.exe wrapper; grandchildren
 * (the actual node/python process) keep the stdio pipes open, so `close` never
 * fires and timeouts hang. `taskkill /T` walks the tree.
 */
function killTree(child: ReturnType<typeof spawn>, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        /* best effort */
      });
    } catch {
      // fall through to direct kill below
    }
    return;
  }
  try {
    child.kill(sig);
  } catch {
    // already gone
  }
}

/**
 * bash — run a shell command.
 *
 * Contract the model can rely on:
 * - non-zero exit is NOT an error: stdout/stderr carry the payload, so the
 *   tool returns normally with exitCode in details
 * - timeout and abort both escalate: SIGTERM, then SIGKILL after a grace period
 * - output is capped head+tail with an explicit marker; nothing is silently lost
 */
export function createBashTool(projectRoot: string): AgentTool<typeof BashParams, BashToolDetails> {
  return {
    name: "bash",
    label: "Run command",
    description:
      "Execute a shell command in the project. Returns stdout/stderr, exit code and duration. " +
      "A non-zero exit code is reported as data, not an error.",
    parameters: BashParams,
    execute: async (_toolCallId, params, signal) => {
      const timeoutMs = params.timeout ?? DEFAULT_TIMEOUT_MS;
      const cwd = params.cwd ? resolveWorkspacePath(projectRoot, params.cwd) : projectRoot;
      const started = Date.now();

      return await new Promise<{
        content: { type: "text"; text: string }[];
        details: BashToolDetails;
      }>((resolve, reject) => {
        let child;
        try {
          child = spawn(params.command, {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          reject(new Error(`Failed to spawn command: ${(error as Error).message}`));
          return;
        }

        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let settled = false;

        const kill = (sig: NodeJS.Signals) => killTree(child, sig);

        const timer = setTimeout(() => {
          timedOut = true;
          kill("SIGTERM");
          // Escalate if the process ignores SIGTERM.
          setTimeout(() => kill("SIGKILL"), 2000).unref();
        }, timeoutMs);

        const onAbort = () => {
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 2000).unref();
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8");
        });

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          fn();
        };

        child.on("error", (error) => {
          finish(() => reject(new Error(`Command failed to start: ${error.message}`)));
        });

        child.on("close", (code, killSignal) => {
          finish(() => {
            const durationMs = Date.now() - started;

            if (signal?.aborted && !timedOut) {
              reject(new Error("Command aborted"));
              return;
            }
            if (timedOut) {
              reject(
                new Error(
                  `Command timed out after ${timeoutMs}ms and was killed.\n` +
                    capOutput(stdout, stderr),
                ),
              );
              return;
            }

            const fullStdout = stdout;
            const fullStderr = stderr;
            const truncated = stdoutBytes > OUTPUT_CAP || stderrBytes > OUTPUT_CAP;

            const text = renderOutput(fullStdout, fullStderr, truncated, stdoutBytes, stderrBytes);

            resolve({
              content: [{ type: "text", text }],
              details: {
                command: params.command,
                exitCode: code,
                signal: killSignal ?? null,
                durationMs,
                truncated,
                stdoutBytes,
                stderrBytes,
                timedOut: false,
              },
            });
          });
        });
      });
    },
  };
}

function capOutput(stdout: string, stderr: string): string {
  return renderOutput(stdout, stderr, true, stdout.length, stderr.length);
}

function renderOutput(
  stdout: string,
  stderr: string,
  truncated: boolean,
  stdoutBytes: number,
  stderrBytes: number,
): string {
  const headCap = Math.floor(OUTPUT_CAP * HEAD_SHARE);
  const tailCap = OUTPUT_CAP - headCap;

  const clip = (text: string, cap: number): string => {
    if (text.length <= cap) return text;
    const head = text.slice(0, Math.floor(cap * HEAD_SHARE));
    const tail = text.slice(-Math.floor(cap * (1 - HEAD_SHARE)));
    return `${head}\n[… ${text.length - head.length - tail.length} characters truncated …]\n${tail}`;
  };

  const parts: string[] = [];
  if (stdout.length > 0) {
    parts.push(truncated && stdoutBytes > OUTPUT_CAP ? clip(stdout, headCap + tailCap) : stdout);
  }
  if (stderr.length > 0) {
    parts.push(
      `--- stderr ---\n${truncated && stderrBytes > OUTPUT_CAP ? clip(stderr, headCap + tailCap) : stderr}`,
    );
  }
  if (parts.length === 0) return "(no output)";
  const body = parts.join("\n");
  return truncated ? `${body}\n[output truncated: ${stdoutBytes + stderrBytes} bytes total]` : body;
}
