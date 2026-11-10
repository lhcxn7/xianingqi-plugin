// Type-only shim for "@deepseek-ai/dsh-tools".
//
// The real package never resolves in a `link:` install (audit M2)
// and is not installed in this repo, so `tsc` cannot find its
// types when it follows the benchmark script's import of the
// dsh-plugin shell (which loads define-tool.ts, which dynamically
// imports dsh-tools). This ambient declaration exists ONLY so
// type-checking passes; it changes nothing at runtime —
// define-tool.ts still tries the real import first and falls back
// to the local compiler when it is absent, exactly as before.
// Do not expand this shim into a fake API surface: the real
// compiler's behaviour is verified by the mock test +真机, not here.

declare module "@deepseek-ai/dsh-tools" {
  export const defineTool: (tool: unknown) => unknown;
}
