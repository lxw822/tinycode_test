import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  CombinedAutocompleteProvider,
  Editor,
  ScrollView,
  TuiAltScreen,
  VStack,
  matchesKey,
  type Component,
  type Terminal,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import type { Harness } from "../bootstrap.js";
import { commandNames, runCommand, type CommandContext } from "./commands.js";
import { LoaderHost } from "./loader-host.js";
import type { PermissionBridge } from "./permission-bridge.js";
import { askPermission } from "./permission-dialog.js";
import { StatusBar } from "./status-bar.js";
import { Transcript } from "./transcript.js";
import { editorTheme } from "./themes.js";

/** How long a second Ctrl+C counts as "again". */
const DOUBLE_CTRL_C_MS = 1500;

export interface TuiAppOptions {
  harness: Harness;
  /** Injected terminal (tests) — defaults to the real process terminal. */
  terminal: Terminal;
  /** Displayed in the status bar; defaults to the process cwd. */
  projectRoot?: string;
  /** Wired to `askPermission` so ASK-level tools open the overlay dialog. */
  bridge?: PermissionBridge;
  /** Welcome line; omitted in tests that assert exact transcript output. */
  greeting?: string;
}

/**
 * TuiApp — ARCHITECTURE §11's full-screen session.
 *
 * Layout (a two-level VStack):
 *
 *   ┌─ ScrollView(transcript, follow end, primary) ─┐
 *   ├─ LoaderHost   (◐ thinking… / N tools running) ├─ bottom: basis auto
 *   ├─ Editor       (prompt box)                    │
 *   └─ StatusBar    (● ready · model · ctx …)       ┘
 *
 * The scroll row is `basis: 0, grow: 1` so it absorbs every remaining row and
 * the bottom stack keeps its intrinsic height — shrinking only when the
 * terminal is genuinely too short.
 *
 * Everything that mutates a component explicitly calls `tui.requestRender()`:
 * pi-tui never repaints on component mutation alone.
 */
export class TuiApp {
  readonly tui: TuiAltScreen;
  readonly transcript: Transcript;
  readonly statusBar: StatusBar;
  readonly loaderHost: LoaderHost;
  readonly editor: Editor;

  private readonly harness: Harness;
  private readonly bridge?: PermissionBridge;
  private readonly removeInput: () => void;
  private readonly removeEvents: () => void;
  private readonly exitPromise: Promise<number>;
  private resolveExit?: (code: number) => void;

  private busy = false;
  private runningTools = 0;
  private lastCtrlCAt = 0;
  private stopped = false;

  /** In-flight submit/command chains, so tests can await quiescence. */
  private pending = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(options: TuiAppOptions) {
    this.harness = options.harness;
    this.bridge = options.bridge;

    this.tui = new TuiAltScreen(options.terminal, false);
    this.transcript = new Transcript(() => this.tui.requestRender());
    this.statusBar = new StatusBar({
      busy: false,
      model: `${options.harness.model.provider}/${options.harness.model.id}`,
      cwd: options.projectRoot ?? process.cwd(),
      tokens: 0,
      subAgents: "",
      session: "",
    });
    this.loaderHost = new LoaderHost(this.tui);
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(commandNames, options.projectRoot ?? process.cwd(), null),
    );
    this.editor.onSubmit = (text) => this.handleSubmit(text);

    const scroll: Component = new ScrollView(this.transcript, {
      follow: "end",
      primary: true,
      scrollbar: "auto",
    });
    const bottom = new VStack([
      { component: this.loaderHost, basis: "auto" },
      { component: this.editor, basis: "auto" },
      { component: this.statusBar, basis: "auto" },
    ]);
    const root = new VStack([
      { component: scroll, basis: 0, grow: 1 },
      { component: bottom, basis: "auto", shrink: 1, minSize: 3 },
    ]);
    this.tui.setLayoutRoot(root);
    this.tui.setFocus(this.editor);

    // Registered after the viewport listener (the TUI's own), so this one runs
    // second and only claims keys the viewport did not consume.
    this.removeInput = this.tui.addInputListener((data) => this.handleInput(data));
    this.removeEvents = this.harness.runtime.subscribe((event) => this.handleEvent(event));

    // The bridge exists from bootstrap; pointing it at the dialog here means an
    // ask can never arrive before the overlay machinery is in place.
    if (this.bridge) this.bridge.setHandler((request) => askPermission(this.tui, request));

    this.exitPromise = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });

    if (options.greeting) this.transcript.info(options.greeting);
    this.refreshStatus();
  }

  // --- lifecycle ----------------------------------------------------------

  /** Enter the alternate screen and resolve when the user quits. */
  async run(): Promise<number> {
    this.tui.start();
    this.tui.requestRender();
    return this.exitPromise;
  }

  /** Leave the alternate screen. Idempotent. */
  quit(code = 0): void {
    if (this.stopped) return;
    this.stopped = true;
    this.removeInput();
    this.removeEvents();
    this.loaderHost.dispose();
    // A dialog can only be open if we are being torn down externally (Ctrl+D
    // is swallowed while an overlay owns focus). Deny it rather than leave the
    // agent loop waiting on a terminal that is already gone.
    this.bridge?.cancelPending();
    this.bridge?.clearHandler();
    if (this.harness.runtime.busy) this.harness.runtime.abort();
    this.tui.stop();
    this.resolveExit?.(code);
  }

  /** Resolves once every submitted prompt/command has finished. */
  async whenIdle(): Promise<void> {
    while (this.pending > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  // --- rendering ----------------------------------------------------------

  /** Force a synchronous repaint — used by tests and by layout-sensitive code. */
  renderNow(): void {
    this.tui.renderNow(true);
  }

  private track(work: Promise<void>): void {
    this.pending += 1;
    const release = (): void => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    };
    // Commands catch their own errors; this is the last line of defence so a
    // rejected chain can neither wedge `whenIdle` nor surface as unhandled.
    void work.then(release, release);
  }

  private refreshStatus(): void {
    this.statusBar.setState({
      model: `${this.harness.model.provider}/${this.harness.model.id}`,
      tokens: this.harness.contextManager.estimate(this.harness.runtime.messages),
      subAgents: this.harness.subAgents.statusLine(),
      session: this.harness.session?.id ?? "",
    });
    this.tui.requestRender();
  }

  // --- input --------------------------------------------------------------

  private handleInput(data: string): TuiInputListenerResult {
    // While the permission dialog is up it owns every key — including Esc and
    // Ctrl+C, which must mean "deny", not "abort the whole run".
    if (this.tui.hasOverlayEntries) return undefined;

    if (matchesKey(data, "ctrl+c")) {
      if (this.busy) {
        this.harness.runtime.abort();
        return { consume: true };
      }
      const now = Date.now();
      if (now - this.lastCtrlCAt <= DOUBLE_CTRL_C_MS) {
        this.quit(0);
        return { consume: true };
      }
      this.lastCtrlCAt = now;
      this.tui.flash("Press Ctrl+C again to exit");
      return { consume: true };
    }

    // Ctrl+D always quits; forward-delete still has the Delete key.
    if (matchesKey(data, "ctrl+d")) {
      this.quit(0);
      return { consume: true };
    }

    // Esc aborts a running turn; when idle it falls through to the editor so
    // it can still cancel an open autocomplete popup.
    if (matchesKey(data, "escape") && this.busy) {
      this.harness.runtime.abort();
      return { consume: true };
    }

    return undefined;
  }

  // --- events -------------------------------------------------------------

  private handleEvent(event: AgentEvent): void {
    this.transcript.applyEvent(event);

    switch (event.type) {
      case "tool_execution_start":
        this.runningTools += 1;
        break;
      case "tool_execution_end":
        this.runningTools = Math.max(0, this.runningTools - 1);
        break;
      case "message_end":
        this.refreshStatus();
        break;
      default:
        break;
    }

    if (this.busy) this.loaderHost.setToolCount(this.runningTools);
  }

  // --- submission ---------------------------------------------------------

  private handleSubmit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.editor.addToHistory(text);
    if (trimmed.startsWith("/")) {
      // Echo the command like any other turn, so history scrolls as expected
      // (`/clear` wipes the echo along with everything else).
      this.transcript.addUser(trimmed);
      this.track(this.execute(trimmed));
      return;
    }
    if (this.busy) return;
    this.track(this.submit(trimmed));
  }

  private async submit(text: string): Promise<void> {
    this.transcript.addUser(text);
    this.setBusy(true);
    try {
      await this.harness.runtime.prompt(text);
      await this.harness.runtime.waitForIdle();
    } catch (error) {
      this.transcript.error(describeError(error));
    } finally {
      this.setBusy(false);
      this.refreshStatus();
    }
  }

  private async execute(line: string): Promise<void> {
    try {
      const output = await runCommand(line, this.commandContext());
      if (output.length > 0) this.transcript.info(output);
    } catch (error) {
      this.transcript.error(describeError(error));
    } finally {
      this.tui.requestRender();
    }
  }

  private commandContext(): CommandContext {
    return {
      harness: this.harness,
      transcript: this.transcript,
      refresh: () => this.refreshStatus(),
      quit: (code) => this.quit(code),
    };
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    // Blocks Enter while a turn runs; the editor keeps accepting text so the
    // user can queue their next thought without losing it.
    this.editor.disableSubmit = busy;
    if (busy) {
      this.loaderHost.show(this.runningTools);
    } else {
      this.loaderHost.hide();
      this.runningTools = 0;
    }
    this.statusBar.setState({ busy });
    this.tui.requestRender();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
