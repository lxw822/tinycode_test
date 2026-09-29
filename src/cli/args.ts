/**
 * CLI argument parsing — explicit, dependency-free, testable.
 *
 * Supported:
 *   tinycode                          interactive session (new)
 *   tinycode -p "prompt"              headless one-shot (read-only by default)
 *   tinycode -p "refactor x" --permission-mode auto
 *   tinycode --model provider/id      / --continue  / --session <id>
 *   tinycode --help | --version
 */

export interface CliArgs {
  mode: "interactive" | "print" | "help" | "version";
  prompt?: string;
  model?: string;
  permissionMode?: "ask" | "auto";
  continue: boolean;
  sessionId?: string;
  /** Discrete project root override (tests). */
  projectRoot?: string;
  errors: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "interactive",
    continue: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-p":
      case "--print": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          args.errors.push(`${arg} requires a prompt string`);
        } else {
          args.mode = "print";
          args.prompt = next;
          i++;
        }
        break;
      }
      case "-m":
      case "--model": {
        const next = argv[i + 1];
        if (next === undefined) args.errors.push(`${arg} requires a value`);
        else {
          args.model = next;
          i++;
        }
        break;
      }
      case "--permission-mode": {
        const next = argv[i + 1];
        if (next !== "ask" && next !== "auto") {
          args.errors.push('--permission-mode must be "ask" or "auto"');
        } else {
          args.permissionMode = next;
          i++;
        }
        break;
      }
      case "-c":
      case "--continue":
        args.continue = true;
        break;
      case "--session": {
        const next = argv[i + 1];
        if (next === undefined) args.errors.push("--session requires an id");
        else {
          args.sessionId = next;
          i++;
        }
        break;
      }
      case "--project-root": {
        const next = argv[i + 1];
        if (next === undefined) args.errors.push("--project-root requires a path");
        else {
          args.projectRoot = next;
          i++;
        }
        break;
      }
      case "-h":
      case "--help":
        args.mode = "help";
        break;
      case "-v":
      case "--version":
        args.mode = "version";
        break;
      default:
        if (arg.startsWith("-")) args.errors.push(`Unknown option: ${arg}`);
        else args.errors.push(`Unexpected argument: ${arg}`);
    }
  }

  if (args.continue && args.sessionId) {
    args.errors.push("--continue and --session are mutually exclusive");
  }
  return args;
}

export const HELP_TEXT = `TinyCode — a minimal coding agent built on Pi

Usage:
  tinycode                          Start an interactive session
  tinycode -p "prompt"              One-shot headless run (ASK operations denied)
  tinycode -p "prompt" --permission-mode auto
                                    Allow state-changing operations unattended

Options:
  -p, --print <prompt>    Run a single prompt and exit (no dialog available)
  -m, --model <ref>       Model reference, e.g. anthropic/claude-haiku-4-5 or "mock"
      --permission-mode   ask (default) | auto
  -c, --continue          Resume the newest session of this directory
      --session <id>      Resume a specific session
      --project-root <p>  Operate on <p> instead of the current directory
  -h, --help              Show this help
  -v, --version           Show version

Environment:
  ANTHROPIC_API_KEY / OPENAI_API_KEY / …   provider credentials (env only)
  TINYCODE_MODEL=provider/id | mock        default model
  TINYCODE_PERMISSION_MODE=ask|auto        default permission mode
  TINYCODE_HOME=<dir>                      data directory override
`;
