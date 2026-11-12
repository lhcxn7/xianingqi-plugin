# 安装 memory-plugin 1.0.0

这份是**完整包**：模型已经随包带在 `dsh-plugin/models/bge-small-zh-v1.5/`，不需要下载模型。

## 1. 解压

解压后得到：

```
memory-plugin-1.0.0\
  core\
  dsh-plugin\
  README.md
  ...
```

## 2. 安装到 DSH

在 DSH 所在机器上执行（把路径换成你解压后的真实路径）：

```sh
dsh plugin --profile <你的 profile> add "<绝对路径>\memory-plugin-1.0.0\dsh-plugin"
```

`core/` 必须和 `dsh-plugin/` 保持同级，插件靠相对路径找核心。

## 3. 重启 DSH

装完必须重启一次，新的插件代码才会加载。

## 4. 首次对话

在人设窗口发一句含 **夏柠柒** 或 **柠柒** 的话，触发人设；然后调 `memory_status` 确认：

- `dataDir` 是你的记忆目录
- `writeBlocked=false`
- `kinds.persona` 有计数
- `semantic.enabled=true` 且 `dependency.runtimePresent=true`（完整包模型在，运行库需首次安装）

## 5. 语义运行库（只有这一步需要联网）

完整包带模型，但不带 `@huggingface/transformers` 这个 JS 运行库。首次启用语义时：

```sh
# 只看命令，不联网
node core/src/admin-cli.ts --dataDir "<你的记忆目录>" semantic install

# 确认后装一次（联网）
node core/src/admin-cli.ts --dataDir "<你的记忆目录>" semantic install --yes
```

装不上就继续用关键词召回，不影响聊天。离线机器把 `@huggingface/transformers` 拷到 `<dataDir>/node_modules/@huggingface/transformers`。

## 6. 验证

```sh
node core/test/eval-048.ts
```

期望 `48-case eval: PASS`，六项指标 1.000 / 0。

更多说明见 `README.md`、`FINAL-ACCEPTANCE.md`、`CHANGELOG.md`。
