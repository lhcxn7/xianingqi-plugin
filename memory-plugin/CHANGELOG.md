# CHANGELOG

## 1.1.0 — 2026-11-13

记忆插件 1.1.0：印象层（Track B）+ 念头格式注入 + 复盘自动留印象；1.0.1 行为对齐（工作区隔离、任务窗口工具边界、语义召回默认开）。

### 新增 / 修正

- **印象层（0.6.0 人味改造第 1 项）**：`memory_fragment` kind `impression`，一句她怎么看他（40 字以内，是她的判断）+ `strategy` 一句打算怎么对他；每条印象 14 天过期，不过期的判断会变成标签；被否掉过的判断不再重复写。
- **念头格式注入（0.6.0 人味改造第 3 项）**：召回注入块改成人话，块头是「脑子里突然冒出来的」，条目按“刚说过 / 前几天 / 前阵子 / 隐约记得”分档，不再是带时间戳的候选列表；有声的印象（voiced line）优先进注入。
- **复盘自动留印象（0.6.0 人味改造第 2 项）**：每日复盘看昨天对话有无新透露，有则自动留 0–2 条印象（判断 + 打算），没有就不硬凑；刚被否掉的判断不重复写。
- **1.0.1 行为对齐**：工作区隔离（只认人设工作区 `C:\夏柠柒` 及其子目录的会话）；任务窗口里 `memory_search` / `memory_remember` / `memory_starmap` / `memory_fragment` 一律返回“只在人设窗口可用”，读记忆直接读 dataDir 的 `MEMORY.md` + `log.jsonl`；Windows 上语义召回随包自带、默认开启。
- **注入仍受 1500 token 总阀门约束**（profile + 命中 + 信念 + 经历共用一个预算）。

### 验证

- 来源：用户云盘 `xianingqi-memory-plugin-1.1.0.zip`（51,203,339 字节，SHA-256 `e8443e4fbf293d2d3db2238bafc6ef45b0222003e4b38edf38203e721d391ecf`，2026-11-13 上传），clean-room 核对通过。
- `dsh-plugin/package.json` manifest 版本 1.1.0；demo 全过（含 0.6.0 人味改造 4 项）；17 个工具；模型 `model_int8.onnx`（23.9 MB）与整套 runtime/node_modules 打进发布包，所以包大，源码推送不含这两样。
- 类型检查（tsc）本次未跑成（npx 拉不到 typescript），未验。

### 已知小毛病

- `core/package.json` 版本号仍写着 1.0.0，跟 manifest 的 1.1.0 对不上，下次打包记得改。

## 1.0.0 — 2026-11-11（封板）

一次性交付，不再拆版本。封板后只修：阻断使用、数据损坏、安全漏洞、严重兼容四类问题。

### 新增 / 修正

- **WP0 数据目录防分家**：`config.dataDir` / `MEMORY_PLUGIN_DATA_DIR` / 默认路径三方对账；显式冲突只读；第二份 `MEMORY.md` 报警；`memory_status` 增 `dataDir` / `memoryFilePresent` / `writeBlocked` / `warning`。
- **WP1 窗口边界**：`entry.kind`（persona/task/greeting）；会话 `mode` 显式声明可切换并跨重启保持；裸触发词记 greeting 但保住 latch；任务形状与聊天信号分离；助手回复 800 字/代码块/表格规则；`memory_search` 加 `includeWork`。
- **WP2 删除一致性**：`forget-ledger.jsonl` 重放，恢复旧快照不复活；`memory-admin purge` 默认 dry-run、打码、`--yes` 执行、审计不含原文；含命中快照整份作废。
- **WP3 恢复一致性**：`restore-journal.json`；恢复后重建索引/图/属性/片段/信念/摘要；校验失败回滚安全快照并保留 journal。`loop.json` 纳入快照（1.0.0 修正）：pending 与 7 天冷却随日志一起回滚；旧快照没有 `loop.json` 时保留当前 loop，不删冷却记录。
- **WP4 冲突与时间**：`validFrom` / `observedAt` / `candidate`；当前版本按 `validFrom` 选；候选默认不注入；缺 `factKey` 提醒不拒绝。
- **WP5 召回治理**：阀门默认 8 条（可配 1–10）；候选提示词；`recall-dropped.jsonl`；语义阈值分档（事实 0.5 / 情景 0.45，0.4 档关闭）；冷启动预热；超时 3s；反思去掉 5 分算术门。
- **WP6 画像 8 类**：`profile.json` 增加爱好习惯、理想、偏好、底线、身体健康、害怕担心、秘密、家人朋友；每条必须带 `sourceIds`；`memory_profile` 按类读写；**不做敏感分级**。
- **WP7 星图**：星海外观保持原样（浮动标签仍是原句预览）；点开后面板左下角徽标改“她/我”；连线来自 `graph.json`；默认隐藏、选中才画；去掉 7 条上限；线宽/透明度按边权重；排除 task/greeting。
- **WP8 语义索引**：`maxEntries` 默认 10000，按重要性×新近度淘汰；只收 persona 聊天；删除/隐藏/失效同步删向量。
- **WP9 自动开语义**：运行库 + 模型都在时自动启用；缺运行库给提示，不静默装；`semantic install --yes` 唯一联网命令；失败退回关键词；README 改口径。
- **WP10 48 条评测**：提取 10、跨会话 8、时间 8、冲突 8、拒答 6、删除残留 4、任务窗口 4；R@5/MRR/误报/删除残留/过期事实/任务泄漏；CLI `node core/test/eval-048.ts`。

### 兼容性

- 旧数据零迁移：`kind`、`validFrom`、`observedAt`、`candidate`、`categories` 全部可选；没有 `kind` 的条目按 persona；`persona-sessions.json` 纯数组按 persona 兼容读取。
- 回滚到 0.5.5：新字段被旧代码忽略；`persona-sessions.json` 若已是对象形态，旧 shell 会读成空（首次触发后重建），回滚前建议备份；`kind=task` 条目在旧代码里会被当 persona 注入，回滚前先 hide。

### 已知限制

- 48 条评测是合成 fixture，只测关键词路径。
- 语义 0.4 分档未启用；自动装依赖需要 npm；模型不自动下载。
- purge 不重写 skill-owned `MEMORY.md` / 月归档 / 日记，只报告。
- 星图线宽视觉需真机打开 `starmap.html` 确认。
