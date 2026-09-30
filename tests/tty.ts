/**
 * Run `fn` with `process.stdin/stdout.isTTY` forced to `false`.
 *
 * The interactive path of the CLI degrades gracefully when there is no TTY,
 * and that branch must be exercised deterministically — whether the suite is
 * run from CI's pipes or from an interactive shell. The descriptors are
 * restored even if `fn` throws.
 */
export async function withNonTTY<T>(fn: () => Promise<T>): Promise<T> {
  const targets: Array<{ owner: object; key: "isTTY" }> = [
    { owner: process.stdin, key: "isTTY" },
    { owner: process.stdout, key: "isTTY" },
  ];
  const saved = targets.map(({ owner, key }) => ({
    owner,
    key,
    descriptor: Object.getOwnPropertyDescriptor(owner, key),
  }));

  for (const { owner, key } of targets) {
    Object.defineProperty(owner, key, { value: false, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const { owner, key, descriptor } of saved) {
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete (owner as Record<string, unknown>)[key];
    }
  }
}
