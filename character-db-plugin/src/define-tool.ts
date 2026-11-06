// defineTool loader + local fallback compiler.
//
// In DSH the real compiler comes from "@deepseek-ai/dsh-tools" — but
// that package NEVER resolves in a `link:` install (verified
// 2026-11-06 for the sibling memory plugin: `await
// import("@deepseek-ai/dsh-tools")` fails with ERR_MODULE_NOT_FOUND
// both in the plugin's own directory and in a profile's
// node_modules, because pnpm installs only the link itself). The
// pass-through fallback used to hand the raw DSL object to
// ctx.tools.register unchanged — register only validates
// output.schema/render, NOT parameters, so the tools registered
// silently with a model-visible schema that had no `type: "object"`,
// no `properties` and no `required`: the model either never called
// them or passed garbage.
//
// So the loader now does one of two things, and NEVER passes raw DSL:
// - if the real package resolves, use its defineTool (it compiles
//   parameters/output and validates args before execute);
// - otherwise WARN LOUDLY once and compile locally: the flat spec
//   map ({name: {type, required?, description?, ...}}) is compiled
//   into a real JSON Schema object ({type:"object", properties,
//   required}), mirroring dsh-tools' parameterSchemaSpecToJsonSchema
//   for the flat specs this plugin uses. Argument validation is NOT
//   replicated here — each execute() validates its own args instead.
//
// The shell self-checks every registered tool's parameters after
// register (see index.ts): a tool whose parameters are not a legal
// JSON Schema is skipped, not registered.

export type DefineToolFn = (tool: unknown) => unknown;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Is this a legal JSON-Schema object schema (the shape the model
 *  must see for a tool's parameters)? */
export function isObjectSchema(s: unknown): boolean {
  return isPlainObject(s) && s.type === "object" && isPlainObject(s.properties);
}

/** Compile a flat parameter spec map into a JSON Schema object.
 *  `required: true` on a property moves into the object-level
 *  `required` array and is stripped from the property, exactly as
 *  dsh-tools' parameterSchemaSpecToJsonSchema does. */
export function compileParameters(spec: unknown): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (isPlainObject(spec)) {
    for (const [name, def] of Object.entries(spec)) {
      if (!isPlainObject(def)) continue;
      const { required: req, ...rest } = def;
      properties[name] = { ...rest };
      if (req === true) required.push(name);
    }
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Local stand-in for defineTool: compiles parameters (and clones the
 *  output schema) and passes everything else through. Throws on a
 *  malformed definition instead of registering garbage. */
export function compileToolLocally(tool: unknown): unknown {
  if (
    !isPlainObject(tool) ||
    typeof tool.name !== "string" ||
    tool.name.length === 0 ||
    typeof tool.execute !== "function"
  ) {
    throw new Error(
      "defineTool: tool definition must have a string name and an execute function",
    );
  }
  const output = isPlainObject(tool.output) ? tool.output : {};
  return {
    ...tool,
    parameters: compileParameters(tool.parameters),
    output: {
      ...output,
      schema:
        output.schema !== undefined
          ? JSON.parse(JSON.stringify(output.schema))
          : { type: "object", properties: {} },
    },
  };
}

let cached: Promise<DefineToolFn> | null = null;
let warnedFallback = false;

export function loadDefineTool(): Promise<DefineToolFn> {
  if (!cached) {
    cached = import("@deepseek-ai/dsh-tools")
      .then((mod) => mod.defineTool as DefineToolFn)
      .catch(() => {
        if (!warnedFallback) {
          warnedFallback = true;
          console.warn(
            "[character-db] @deepseek-ai/dsh-tools 解析失败（link: 安装不会装它），工具参数改由本地编译成 JSON Schema；模型可见的 schema 与真 defineTool 一致，但参数校验由各 execute 自行负责。发布时请把 dsh-tools 打进构建产物，见 README 的发布说明。",
          );
        }
        return compileToolLocally;
      });
  }
  return cached;
}
