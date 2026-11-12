# 记忆插件 1.0.0 · 封板验收

> 日期：2026-11-11
> 版本：**1.0.0**（`core/package.json` / `dsh-plugin/package.json` / `VERSION`）
> 状态：**封板**。此后只修四类问题：阻断使用、数据损坏、安全漏洞、严重兼容；不再加功能。

---

## 一、交付内容

| 包 | 内容 |
|---|---|
| `core/` | 本地记忆引擎：日志、索引、图、属性、片段、信念、目标、经验、快照、删除账本、恢复 journal、画像、语义索引、48 条评测 |
| `dsh-plugin/` | DSH 外壳：17 个工具、persona/task 窗口、召回注入、每日复盘、星图、软引导、语义自动开/安装提示 |
| 文档 | `README.md`、`CHANGELOG.md`、`MODELS.md`、`LOCAL-EMBEDDING.md`、`VERSION`、本文件 |

17 个工具：`memory_profile / search / remember / daily_review / fragment / snapshot / restore / status / starmap / invalidate / belief / reflect / proact / feedback / forget / goal / experience`。

---

## 二、验收结果（全部通过）

| 域 | 验收 | 结果 |
|---|---|---|
| 窗口边界 | 12 条用例 + shell 用例（greeting/声明/task/重启） | 13 passed + mock ALL PASS |
| 数据目录 | 三处对账、只读模式、`memory_status` 字段 | mock `PASS WP0` |
| 删除 | 账本重放、恢复不复活、purge dry-run/打码/审计无原文 | 5 passed |
| 恢复 | 有效恢复、loop.json 随快照回滚、旧快照无 loop 时保留当前 loop、中断回滚、坏快照校验失败回滚 | 5 passed |
| 冲突时间 | validFrom、历史版本、supersedes、两个 factKey 并存、候选 | 7 passed |
| 召回治理 | 阀门 8/10、候选提示、裁剪 onDrop、反思无算术门、3s 超时 | 5 passed |
| 画像 | 8 类写入/读回/深合并/来源必填 | 3 passed + mock `PASS WP6` |
| 星图 | 星海外观不变；点开面板左下角“她/我”；graph 边、按权重画；task/greeting 不出星 | 3 passed + demo P7/P8 |
| 语义索引 | 10000 上限、只收 persona、重要性×新近度 | 3 passed |
| 运行库安装 | dry-run、无 `--yes` 不执行、autoEnable/显式优先级、dependency | 4 passed |
| 48 条评测 | 提取/跨会话/时间/冲突/拒答/删除/任务 | **PASS：R@5 1.000，MRR 1.000，误报/删除残留/过期事实/任务泄漏全 0** |
| 全量回归 | `core/test/demo.ts` | ALL PASS |
| 真机冷加载 | 真实数据副本 + live 代码 | 11 项 PASS |
| 回滚演练 | 0.5.5 旧代码 + 1.0.0 新代码读同一份数据副本 | **ROLLBACK DRILL PASS** |

---

## 三、安装与首次初始化

```sh
# 1) 装插件（整棵树，core 与 dsh-plugin 必须同级）
dsh plugin --profile <name> add "<绝对路径>\dsh-plugin"

# 2) 重启 DSH

# 3) 人设窗口发一句含触发词的话（夏柠柒 / 柠柒）

# 4) 看状态
#    在聊天里调 memory_status，确认：
#    dataDir / memoryFilePresent=true / writeBlocked=false / layer2Count / kinds
```

数据目录必须只有一个源头：

- `config.dataDir`，或
- 环境变量 `MEMORY_PLUGIN_DATA_DIR`，或
- 默认 `~/.dsh/xia-ningqi-data`。

前两者同时设置且不一致时，插件进入**只读模式**（召回/状态照常，写入拒绝），并在 `memory_status.warning` 说明。

---

## 四、语义运行库（唯一联网步骤）

```sh
# 只看命令，不联网
node core/src/admin-cli.ts --dataDir "<dataDir>" semantic install

# 确认后装一次（联网）
node core/src/admin-cli.ts --dataDir "<dataDir>" semantic install --yes
```

- 模型文件随包带，不下载。
- 运行库 + 模型都在时，**下次启动自动开语义**（`semanticRecall.autoEnable` 默认 true）。
- 装不上：保持关键词召回，不报错、不重试。
- 离线：把 `@huggingface/transformers` 拷到 `<dataDir>/node_modules/@huggingface/transformers`。

---

## 五、备份、恢复、删除

```sh
# 快照/恢复（人设窗口工具或 CLI）
memory_snapshot
memory_restore <snapshot-name>

# 删除申请 → CLI 批准 → 执行
node core/src/admin-cli.ts --dataDir "<dir>" forget request --mode delete --ids a,b --reason "..."
node core/src/admin-cli.ts --dataDir "<dir>" forget approve <request-id>
node core/src/admin-cli.ts --dataDir "<dir>" forget execute <request-id>

# 敏感串擦除：默认 dry-run，--yes 才执行
node core/src/admin-cli.ts --dataDir "<dir>" purge --pattern-file "<file>"
node core/src/admin-cli.ts --dataDir "<dir>" purge --pattern-file "<file>" --yes
```

- 删除账本 `forget-ledger.jsonl` 不在快照里；恢复旧快照会重放账本，删掉的不复活。
- `loop.json` 随快照走：pending actions 与 7 天冷却一起回滚；恢复 1.0.0 以前的旧快照时，因为旧快照没有 `loop.json`，会保留当前 loop，不会删掉现存冷却记录。
- `purge` 会清日志、索引、图、属性、片段、信念、摘要、向量；含命中的旧快照整份作废；审计不记 pattern/原文。
- `MEMORY.md`、月归档、日记是 skill-owned，`purge` 只报告不重写。

---

## 六、回滚

1. 先备份当前数据目录。
2. 把 `memory-plugin` 树换回备份（如 `xianingqi-plugin.bak-before-wp10-20261111-1503`）。
3. 重启 DSH。
4. 数据格式兼容：`kind` / `validFrom` / `observedAt` / `candidate` / `categories` 旧代码忽略。
5. 注意：
   - `persona-sessions.json` 若已是对象形态，旧 shell 会读成空（下次触发重建）；回滚前可保留备份。
   - `kind=task` 条目在旧代码里会被当 persona 注入；回滚前先 hide 这些条目。
6. 回滚演练已通过：0.5.5 与 1.0.0 都能加载同一份 233 条真实数据副本。

---

## 七、故障排查

| 现象 | 先看 |
|---|---|
| 记忆没写进去 | `memory_status.writeBlocked`、`warning`、`dataDir`；三处路径是否冲突 |
| `layer2Count` 为 0 | `dataDir` 里有没有 `MEMORY.md`；是不是又分家了 |
| 语义没开 | `memory_status.semantic.dependency.runtimePresent`；跑 `semantic install` |
| 语义开了但召回没变好 | `indexStatus` / `indexSize`；模型 revision 是否一致 |
| 删了又回来 | 是否恢复了删除前快照；看 `forget-ledger.jsonl` 是否被重放 |
| 恢复报错 | 看 `restore-journal.json` 的 `status` / `error`；安全快照名 |
| 任务内容进了记忆 | 看 `kinds.task` 计数；确认有没有说“任务窗口” |

---

## 八、已知限制

- 48 条评测是合成 fixture，只测关键词路径。
- 语义 0.4 分档未启用；自动装依赖需要 npm；模型不自动下载。
- `purge` 不重写 skill-owned 文件；模型转述型片段/信念的按内容清理留待后续。
- 星图线宽/标签的真实观感需要打开 `starmap.html` 确认。
- 没有真实浏览器自动化；UI 测试用 stub DOM。
- 本源码树不是 git 仓库，**没有创建 git tag**；版本以 `VERSION`、两份 `package.json` 和本文件为准。

---

## 九、封板纪律

- 不再新增功能、不再规划下一版本。
- 只修：阻断使用、数据损坏、安全漏洞、严重兼容。
- 新想法进“不纳入本插件”清单，优先考虑做成独立器官插件（灵魂/语音/视觉/行动）。
- 任何修复都要：改副本 → 跑全量（含 48 条 eval）→ 备份 live → 只同步改动文件 → live 树复跑。
