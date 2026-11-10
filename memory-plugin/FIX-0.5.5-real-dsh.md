# 0.5.5 真机修复说明（DSH 0.2.2-rc.1）

本包是 `plugin-0.5.5.zip` 的修复版。原始 zip 未改动。
两个 bug 只在真实 DSH 上出现，mock 测试（219 PASS）测不到。

## BUG-1：render 签名不匹配（P0，影响全部 17 个工具）

DSH 的 tool pipeline 调用：

```js
rendered = tool.output.render(exec.arguments, value);
```

`@deepseek-ai/dsh-tools` 的 `defineTool` 契约也是 `render(args, value)`。
0.5.5 的 17 个 render 全部写成 `render: (value) => ...`，于是真机把
**调用入参**当成工具结果返回（例如 `memory_search` 只回
`{"query":"酸梅汤"}`）。

修复：17 处改为 `render: (_args: unknown, value: unknown) => ...`。

## BUG-2：自由对象输出 schema 被关死（P0）

`memory_status` 在真机报：

```
tool "memory_status" returned invalid output:
"value.beliefDimensions.safety" is not a declared property (additionalProperties: false);
... "value.semantic.enabled" ...
```

根因：`beliefDimensions`、`semantic` 等 10 处输出对象写成
`{ type: "object" }`（没有 properties），而 `normalizeSchemaForDshTools`
会给每个 object 补 `additionalProperties: false`，DSH 按封闭对象校验，
必然失败。

修复：这 10 处改为
`{ type: "object", additionalProperties: true }`。
涉及：profile、beliefDimensions、semantic、dimensions、belief、action、
counts、preview、goal、experience。

## 回归测试

`dsh-plugin/test/mock-test.ts` 新增 2 条 DSH 契约检查：

1. 每个工具的 `render.length >= 2`，且 `render(args, value)` 渲染的是
   `value` 而不是 `args`；
2. 输出 schema 里所有自由对象必须 `additionalProperties: true`。

## 验证结果

- demo：260 PASS / 0 FAIL
- mock：221 PASS / 0 FAIL（原 219 + 2 条契约测试）
- tsc（core）：exit 0，0 错
- 真机（DSH 0.2.2-rc.1，desktop profile）：
  - `memory_status`：tools 17，modelPresent true，无 INVALID_TOOL_OUTPUT
  - task 窗口：memory_search / memory_remember 正确拒绝
  - 人设窗口：memory_remember 写入，memory_search 召回
  - 双窗口：跨会话召回正常
  - 重启 DSH 后：tools 仍为 17

## 安装

与普通包相同，整棵树必须在一起（core 与 dsh-plugin 同级）：

```
dsh plugin --profile <name> add "<绝对路径>\dsh-plugin"
```

或在 DSH GUI：设置 → 插件 → 添加插件 → 绝对路径到 `dsh-plugin`。
