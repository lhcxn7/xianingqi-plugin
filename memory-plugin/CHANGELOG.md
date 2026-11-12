# CHANGELOG

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
