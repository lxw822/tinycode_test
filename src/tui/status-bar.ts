import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { dim, green, red, yellow } from "./themes.js";

/**
 * Status bar — ARCHITECTURE §11's single bottom line:
 *
 *   ● ready · mock · E:\tinycode_test · ctx ~12k · SUB-AGENTS 1/3 · session 4f2a1b
 *
 * All rendering is derived from state the app pushes in; the component never
 * reaches back into the harness, so it stays a pure function of its fields
 * (which is exactly what makes it assertable in tests).
 */
export interface StatusBarState {
  busy: boolean;
  model: string;
  cwd: string;
  tokens: number;
  /** Pre-formatted sub-agent line from SubAgentManager.statusLine(), or "". */
  subAgents: string;
  /** Session id, or "" when running ephemeral. */
  session: string;
}

/** `1234` → `1.2k`, `42` → `42`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export class StatusBar implements Component {
  private state: StatusBarState;

  constructor(initial: StatusBarState) {
    this.state = initial;
  }

  getState(): StatusBarState {
    return this.state;
  }

  setState(patch: Partial<StatusBarState>): void {
    this.state = { ...this.state, ...patch };
  }

  invalidate(): void {
    // Stateless: nothing cached between renders.
  }

  render(width: number): string[] {
    const s = this.state;
    const indicator = s.busy ? yellow("● working") : green("● ready");
    const parts = [indicator, dim(s.model), s.cwd, dim(`ctx ~${formatTokens(s.tokens)}`)];
    if (s.subAgents.length > 0) parts.push(red(s.subAgents));
    if (s.session.length > 0) parts.push(dim(`session ${s.session.slice(0, 8)}`));
    return [truncateToWidth(parts.join(dim(" · ")), width, "…")];
  }
}
