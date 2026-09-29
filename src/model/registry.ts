import type { Model, MutableModels } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
// builtinModels is NOT on the package root — the catalog factory lives in the
// providers/all subpath export (verified against the installed package).
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";

/**
 * ModelRegistry wraps pi-ai's model collections with TinyCode's selection
 * order and a mock escape hatch:
 *
 *   CLI --model provider/id  >  TINYCODE_MODEL  >  config  >  first auth-configured
 *
 * `enableMock()` registers pi's scripted faux provider so the whole loop —
 * tests, `-p` smoke runs, zero-setup first launch — works with no network and
 * no API key.
 */

export interface ModelRef {
  provider?: string | undefined;
  model?: string | undefined;
}

export interface ModelResolution {
  model: Model<any>;
  /** True when the resolved model is the offline faux mock. */
  mock: boolean;
}

export class ModelResolutionError extends Error {
  constructor(
    message: string,
    readonly guidance: string,
  ) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

const MOCK_PROVIDER = "faux";

export class ModelRegistry {
  private readonly models: MutableModels;
  private faux: FauxProviderHandle | undefined;
  private maxOutputTokens: number | undefined;

  constructor(models?: MutableModels) {
    this.models = models ?? builtinModels();
  }

  /** The underlying pi-ai collection (for Models.streamSimple / completeSimple). */
  get collection(): MutableModels {
    return this.models;
  }

  setMaxOutputTokens(tokens: number | undefined): void {
    this.maxOutputTokens = tokens;
  }

  getMockHandle(): FauxProviderHandle | undefined {
    return this.faux;
  }

  /** Register the scripted faux provider (id `mock`). Idempotent. */
  enableMock(): FauxProviderHandle {
    if (this.faux) return this.faux;
    const handle = fauxProvider({
      provider: MOCK_PROVIDER,
      models: [{ id: "mock", name: "Mock (offline)", contextWindow: 200_000, maxTokens: 8192 }],
    });
    this.models.setProvider(handle.provider);
    this.faux = handle;
    return handle;
  }

  isMockRef(ref: ModelRef): boolean {
    return (
      ref.model === "mock" ||
      ref.provider === MOCK_PROVIDER ||
      ref.provider === "mock" ||
      `${ref.provider ?? ""}/${ref.model ?? ""}` === `${MOCK_PROVIDER}/mock`
    );
  }

  /**
   * Resolve a model reference to a concrete `Model`.
   *
   * Throws `ModelResolutionError` with actionable guidance instead of
   * crashing later inside a provider stream.
   */
  /** A model is the offline mock when it comes from the faux provider. */
  private isMockModel(model: Model<any>): boolean {
    return model.provider === MOCK_PROVIDER;
  }

  async resolve(ref: ModelRef = {}): Promise<ModelResolution> {
    if (this.isMockRef(ref)) {
      const handle = this.enableMock();
      return { model: handle.getModel() as Model<any>, mock: true };
    }

    // Explicit provider/model pair.
    if (ref.provider && ref.model) {
      const found = this.models.getModel(ref.provider, ref.model);
      if (found) return { model: this.applyLimits(found), mock: this.isMockModel(found) };
      throw new ModelResolutionError(
        `Unknown model: ${ref.provider}/${ref.model}`,
        this.availableHint(),
      );
    }

    // Model id only — search all providers.
    if (ref.model && !ref.provider) {
      const matches = this.models.getModels().filter((m) => m.id === ref.model);
      if (matches.length === 1)
        return { model: this.applyLimits(matches[0]!), mock: this.isMockModel(matches[0]!) };
      if (matches.length > 1) {
        throw new ModelResolutionError(
          `Model id "${ref.model}" is ambiguous across providers: ${matches
            .map((m) => `${m.provider}/${m.id}`)
            .join(", ")}`,
          `Pass the full reference, e.g. --model ${matches[0]!.provider}/${matches[0]!.id}`,
        );
      }
      // Provider id used in the model slot: `--model anthropic`.
      const provider = this.models.getProvider(ref.model);
      if (provider) {
        const first = provider.getModels()[0];
        if (first) return { model: this.applyLimits(first), mock: this.isMockModel(first) };
      }
      throw new ModelResolutionError(
        `Unknown model or provider: ${ref.model}`,
        this.availableHint(),
      );
    }

    // No reference, but the mock was explicitly enabled: offline wins.
    // `enableMock()` is a deliberate request (tests, `-p` smoke runs, zero-setup
    // first launch) — never let a real API key in the environment shadow it.
    if (this.faux) {
      return { model: this.faux.getModel() as Model<any>, mock: true };
    }

    // No reference: first provider with configured auth, else actionable error.
    const available = await this.models.getAvailable().catch(() => []);
    if (available.length > 0) {
      return { model: this.applyLimits(available[0]!), mock: this.isMockModel(available[0]!) };
    }

    throw new ModelResolutionError(
      "No model configured (no provider has credentials)",
      "Set an API key (e.g. ANTHROPIC_API_KEY), or run offline with TINYCODE_MODEL=mock.",
    );
  }

  /** List configured models for UI/CLI pickers: provider/model strings. */
  listAvailable(): string[] {
    return this.models
      .getModels()
      .map((m) => `${m.provider}/${m.id}`)
      .sort();
  }

  private applyLimits(model: Model<any>): Model<any> {
    if (this.maxOutputTokens === undefined) return model;
    const current = typeof model.maxTokens === "number" ? model.maxTokens : undefined;
    if (current !== undefined && current <= this.maxOutputTokens) return model;
    return { ...model, maxTokens: this.maxOutputTokens };
  }

  private availableHint(): string {
    const list = this.listAvailable();
    if (list.length === 0) {
      return "No models are configured. Set an API key (e.g. ANTHROPIC_API_KEY) or TINYCODE_MODEL=mock.";
    }
    const sample = list.slice(0, 12).join(", ");
    return `Available: ${sample}${list.length > 12 ? `, … (${list.length} total)` : ""}`;
  }
}

/** Convenience: a registry preloaded with only the faux provider (tests). */
export function mockRegistry(): { registry: ModelRegistry; handle: FauxProviderHandle } {
  const registry = new ModelRegistry(createModels());
  const handle = registry.enableMock();
  return { registry, handle };
}
