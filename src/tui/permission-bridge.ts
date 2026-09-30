import type {
  PermissionAnswer,
  PermissionPromptFn,
  PermissionRequest,
} from "../permissions/manager.js";

/**
 * The seam between bootstrap (which must own the prompt hook from the start)
 * and the TUI (which only exists a moment later).
 *
 * `bootstrapHarness({ permissionPrompt: bridge.prompt })` is called before any
 * TUI object exists, then `bridge.setHandler(...)` points it at the dialog once
 * the app is up. Until that happens — and after `clearHandler()` on teardown —
 * the bridge answers `deny`, so an unattended ask degrades exactly the way
 * headless `-p` does rather than hanging or silently allowing.
 *
 * Promises are chained so two tools asking simultaneously queue up instead of
 * stacking two overlays on top of each other, and `cancelPending()` exists so
 * tearing the TUI down mid-ask can never leave the agent loop wedged.
 */
export class PermissionBridge {
  private handler?: (request: PermissionRequest) => Promise<PermissionAnswer>;
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private readonly waiters = new Set<(answer: PermissionAnswer) => void>();

  /** The hook handed to `bootstrapHarness`. */
  readonly prompt: PermissionPromptFn = (request) =>
    new Promise<PermissionAnswer>((resolve) => {
      // Idempotent: teardown may settle this while `run` is still pending.
      const settle: (answer: PermissionAnswer) => void = (answer) => {
        if (this.waiters.delete(settle)) {
          this.inFlight -= 1;
          resolve(answer);
        }
      };
      this.waiters.add(settle);
      this.inFlight += 1;

      const run = async (): Promise<PermissionAnswer> => {
        if (!this.handler) return "deny";
        try {
          return await this.handler(request);
        } catch {
          // A crashed dialog must not take the agent loop down with it.
          return "deny";
        }
      };
      const next = this.queue.then(run, run);
      // Keep the chain alive regardless of how `run` settles.
      this.queue = next.then(
        () => undefined,
        () => undefined,
      );
      void next.then(settle, () => settle("deny"));
    });

  setHandler(handler: (request: PermissionRequest) => Promise<PermissionAnswer>): void {
    this.handler = handler;
  }

  clearHandler(): void {
    this.handler = undefined;
  }

  /** Answer every outstanding ask with `deny` and reset the queue. */
  cancelPending(): void {
    for (const settle of [...this.waiters]) settle("deny");
    this.queue = Promise.resolve();
  }

  /** Number of asks submitted but not yet answered (tests + diagnostics). */
  get pending(): number {
    return this.inFlight;
  }
}
