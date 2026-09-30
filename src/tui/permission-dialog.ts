import {
  SelectList,
  Text,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { PermissionAnswer, PermissionRequest } from "../permissions/manager.js";
import { argsSummary } from "./format.js";
import { bold, dim, red, selectListTheme, yellow } from "./themes.js";

/**
 * The permission ask — ARCHITECTURE §11's centered overlay.
 *
 * The dialog is the focused overlay component, so it must implement
 * `handleInput` itself (VStack does not forward input); each keystroke is
 * passed to the embedded SelectList. Resolving hides the overlay, which
 * restores focus to whatever was focused before — normally the editor.
 *
 * The promise form matters: `PermissionManager.check()` awaits the prompt from
 * inside the agent loop's `beforeToolCall` hook, so the loop is blocked until
 * the user picks an answer. Cancelling (Esc / Ctrl+C) answers `deny` — never
 * "keep waiting" — because a hung ask would hang the whole run.
 */
export class PermissionDialog implements Component {
  focused = false;

  private readonly header: Text;
  private readonly list: SelectList;

  constructor(
    private readonly request: PermissionRequest,
    private readonly onAnswer: (answer: PermissionAnswer) => void,
  ) {
    this.header = new Text(this.headerText(), 1, 1);
    this.list = new SelectList(
      [
        { value: "deny", label: "Deny", description: "block and tell the model" },
        { value: "allow-once", label: "Allow once", description: "run this call only" },
        {
          value: "allow-always",
          label: "Always allow",
          description: `remember ${request.pattern}`,
        },
      ],
      3,
      selectListTheme,
    );
    // Deny is the default: a stray Enter must not open the write path.
    this.list.onSelect = (item) => this.onAnswer(item.value as PermissionAnswer);
    this.list.onCancel = () => this.onAnswer("deny");
  }

  private headerText(): string {
    const { toolName, args, reason, pattern, risk } = this.request;
    const target = argsSummary(toolName, args);
    const lines = [
      `${yellow("●")} ${bold(toolName)}${target ? ` ${target}` : ""}`,
      `${dim("reason")}  ${reason}`,
      `${dim("pattern")}  ${pattern}`,
    ];
    if (risk) lines.push(`${red("risk")}     ${risk}`);
    lines.push("");
    lines.push(dim("Enter to confirm · Esc to deny"));
    return lines.join("\n");
  }

  /** Forward keys to the list — this is what makes the overlay interactive. */
  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.header.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [...this.header.render(width), ...this.list.render(width)];
  }
}

/**
 * Show the dialog as a centered overlay and resolve with the user's answer.
 *
 * Returns `deny` immediately if the overlay cannot be focused (e.g. a
 * degenerate terminal size) — same safety posture as the bridge's no-handler
 * fallback.
 */
export function askPermission(tui: TUI, request: PermissionRequest): Promise<PermissionAnswer> {
  return new Promise<PermissionAnswer>((resolve) => {
    let handle: OverlayHandle | undefined;
    const answer = (value: PermissionAnswer): void => {
      handle?.hide();
      handle = undefined;
      tui.requestRender();
      resolve(value);
    };
    const dialog = new PermissionDialog(request, answer);
    handle = tui.showOverlay(dialog, {
      width: "70%",
      minWidth: 40,
      anchor: "center",
    });
    if (!handle.isFocused()) {
      // Overlay never took focus — do not leave the agent loop waiting.
      handle.hide();
      handle = undefined;
      tui.requestRender();
      resolve("deny");
      return;
    }
    tui.requestRender();
  });
}

/** Convenience for tests: render the dialog's lines without a live TUI. */
export function renderPermissionDialog(request: PermissionRequest, width: number): string[] {
  const dialog = new PermissionDialog(request, () => undefined);
  return dialog.render(width);
}
