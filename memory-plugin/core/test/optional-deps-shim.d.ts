// Type-only shim for the OPTIONAL embedding runtime.
//
// `@huggingface/transformers` is an optionalDependency of core: a
// clean checkout without it must still typecheck, because semantic
// recall degrades to keyword-only at runtime when the module or the
// model is missing. TypeScript still resolves a dynamic `import()`
// statically, so without this shim a clean package fails with
// TS2307 even though the runtime path is guarded.
//
// This file changes nothing at runtime. It declares the two members
// semantic.ts uses (`env`, `pipeline`); the concrete extractor type is
// local to semantic.ts. When the real package is installed, its own
// declarations win for consumers that import it directly.

declare module "@huggingface/transformers" {
  export const env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    [key: string]: unknown;
  };
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}
