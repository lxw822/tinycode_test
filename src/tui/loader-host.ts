import { Loader, type Component, type TUI } from "@earendil-works/pi-tui";
import { dim } from "./themes.js";

/**
 * LoaderHost — the row above the editor.
 *
 * ARCHITECTURE §11 wants `◐ thinking…` when idle-busy and a running-tool count
 * while tools execute. The Loader is constructed with a single frame so
 * `restartAnimation()` never arms an interval (a stray timer keeps vitest's
 * event loop alive); `show()`/`hide()` only toggle message text, and
 * `dispose()` is belt-and-braces for teardown.
 */
export class LoaderHost implements Component {
  private readonly loader: Loader;
  private visible = false;
  private toolCount = 0;

  constructor(tui: TUI) {
    this.loader = new Loader(tui, dim, dim, "thinking…", { frames: ["◐"] });
    // Construction restarts the (single-frame) animation; stop it so nothing
    // polls until the app explicitly shows the loader.
    this.loader.stop();
  }

  /** Show the loader. An omitted count keeps whatever `setToolCount` last set. */
  show(toolCount?: number): void {
    if (toolCount !== undefined) this.toolCount = toolCount;
    this.visible = true;
    this.loader.setMessage(this.message());
    this.loader.start();
  }

  hide(): void {
    this.visible = false;
    this.loader.stop();
  }

  /** Update the running-tool count without changing visibility. */
  setToolCount(toolCount: number): void {
    this.toolCount = toolCount;
    if (this.visible) this.loader.setMessage(this.message());
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Ensure no animation timer outlives the app. */
  dispose(): void {
    this.loader.stop();
    this.visible = false;
  }

  private message(): string {
    return this.toolCount > 0
      ? `${this.toolCount} tool${this.toolCount === 1 ? "" : "s"} running`
      : "thinking…";
  }

  invalidate(): void {
    this.loader.invalidate();
  }

  render(width: number): string[] {
    if (!this.visible) return [];
    // Loader.render prefixes a blank separator line; keep it as the visual
    // break between transcript and editor.
    return this.loader.render(width);
  }
}
