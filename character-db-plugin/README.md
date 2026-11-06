# 人物数据库 DSH 插件（@character-db/dsh-plugin）

让夏柠柒的 skill 在聊天里按需查人物数据库的工具壳。只读、不联网、不登录、不写库。

## 这是什么

人物数据库（`~/workspace/character-db/xia-ningqi/`，448 条）是原著 canon 的结构化意译底子：她说过什么、内心怎么想、关键事件、人物关系、说话规则。skill 是行为规矩（她怎么说话、什么绝不能做），数据库是证据。skill 自己读不到 JSON，模型也记不住 448 条，这个插件给模型两个工具，让它在需要核对原著细节时自己查。

## 为什么是工具-only，不做自动注入

skill 的铁律是：**小说剧情绝不进入对话**。自动注入（session-start 回忆、pre-step 拦截、systemPrompt 上下文）会把原著事件硬塞进每一轮聊天，不管使用者想不想听——那正是铁律要挡的东西。

所以这个插件：

- 只注册两个工具，**不写任何钩子**：没有 `agent/pre-step`、没有 `session/event`、没有 `systemPrompt.context`、没有 `ctx.effect`。`inject` 是 `["tools", "systemPrompt"]`——`systemPrompt` 只是为了注册下面那段静态工具说明，别无他用。
- 只有模型主动调用时才返回条目；说什么、怎么说，继续由 skill 的规则管。
- 两个工具的描述里都写了 guard：条目是意译、不是她的原话，绝不能当作她说过的话直接引用；关键事件是小说背景，绝不是与聊天使用者的共同经历。

## 工具说明 section（0.1.1 新增）

光有工具不够：模型不知道工具存在，就不会主动调。所以插件在加载时用 `ctx.systemPrompt.section()` 注册一段**静态**指令（id `character-db:tools`），全文是：

> 人物数据库工具已启用：有两个只读工具可供调用。character_search——按关键词加过滤器（集合类型、章节、对象、情绪、阶段）检索人物数据库，返回按相关度排序的意译条目；character_lookup——按 id 取一条完整条目。只在需要核对原著细节时才调用：某句台词的口吻、某件事的来龙去脉、某个人物的关系、某个名字的写法。不要为了闲聊主动查库。返回的条目是意译、不是她的原话，绝不能当作她说过的话直接引用；关键事件是小说背景，绝不是与聊天使用者的共同经历。

为什么只写工具用法、不写原著内容：这段指令是**说明书**，不是**课文**。它只告诉模型“有这两个工具、什么时候该调、调回来以后不许怎么用”，里面没有任何条目、没有任何原著事实、没有任何回忆。写原著内容进去就是自动注入——不管使用者想不想听，每轮聊天都先塞一段小说剧情，那正是铁律要挡的东西。模型只有在真的需要核对细节时才会调工具，调回来的条目也仍然受 skill 的规则管着。所以这段 section 不破 tools-only 的保证：它不注入内容，只让工具能被看见、被正确使用。重复注册（同一进程里插件被加载两次）不会让插件挂掉，只会记一条警告，工具本身不受影响。

记忆插件（`~/workspace/memory-plugin/`）走的是另一条路：它记的是**真实对话**，自动注入没问题。人物数据库记的是**原著**，自动注入就是破铁律。两个插件互补，不冲突。

## 要求

- DSH `>=0.2.0 <0.3.0`，Node `^22.19 || >=24`
- 人物数据库目录在手边（默认 `~/workspace/character-db/xia-ningqi/`）

## 安装

GitHub 安装：

```sh
dsh plugin --profile <你的 profile 名> add github:lhcxn7/xianingqi-plugin#v0.1.6&path:/character-db-plugin
```

（分支 v0.1.6 是本次两插件同批快照，插件本身版本 0.1.1。）

本地路径安装：

```sh
dsh plugin --profile <你的 profile 名> add <character-db/dsh-plugin 文件夹的完整路径>
```

装完**手动重启 DSH**（插件只有重启后才加载）。数据库文件夹和插件文件夹要放在固定位置、保持在一起的相对关系倒不必——插件只认 `dataDir`，见下。

数据库本身在 skill 库里：https://github.com/lhcxn7/xia-ningqi-skill 的 `character-db/xia-ningqi/`（448 条，1–312 章），clone 下来后把 `dataDir`（或 `CHARACTER_DB_DATA_DIR`）指到那个目录就能用，不用再单独拷库。

## 配置

优先级：插件配置 `dataDir` > 环境变量 `CHARACTER_DB_DATA_DIR` > 默认 `~/workspace/character-db/xia-ningqi/`。

- **换角色**：把 `dataDir` 指向另一个角色目录（`lin-chuxue/`、`musheng/`……）即可，schema 同一套，不用换插件。
- **Windows 上**：默认路径在那台电脑上不存在，必须显式设 `dataDir`。最稳的办法是用户环境变量（PowerShell，设完重启 DSH）：

```powershell
[Environment]::SetEnvironmentVariable("CHARACTER_DB_DATA_DIR", "E:\deepseek\custom-skills\character-db\xia-ningqi", "User")
```

- `tokenCap`（默认 1500）：一次 `character_search` 回答的 token 估算上限。超了就按分数从低到高截掉多余条目，并在回答里注明截掉了几条、怎么缩小范围再查。估算很粗（中文 1 字 ≈ 1 token，拉丁文约 4 字符 ≈ 1 token），只用来截断，不作计费依据。

插件配置本身由 DSH 在 `apply(ctx, config)` 的第二个参数传入（和记忆插件一样）；**不要读 `ctx.config`，那个属性在真实 DSH 里不存在，读了插件直接加载失败**（2026-11-05 记忆插件在真机上踩过这个坑，mock 测试里有 Proxy 回归检查）。

## 两个工具

### character_search — 按关键词检索

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 否 | 关键词或短语；为空时按过滤条件列出 |
| `type` | 否 | 集合：`lines` 台词 / `inner` 内心独白 / `events` 关键事件 / `traits` / `relationships` / `rules` / `arc` / `profile` / `flags` |
| `chapter` | 否 | 章节：单章 `107`、范围 `131-165`、重号 `151a` |
| `addressee` | 否 | 说话对象，如 `祁南`、`叶安苒`、`林小小` |
| `emotion` | 否 | 情绪，如 `吃醋`、`冷拒`、`撒娇`、`害羞` |
| `stage` | 否 | 阶段：`early` / `mid` / `late` |
| `limit` | 否 | 最多返回几条，默认 5，最多 20 |

关键词和过滤条件至少给一个。返回：`ok`、`totalHits`、`returned`、`truncated`、`dropped`、`estimatedTokens`、`tokenCap`、截断说明 `note`，以及 `results`（每条含 `id`、`type`、章节、对象、情绪、`scene`、意译 `text`、`source`、`score`）。

打分与 `query.mjs` 完全一致：标签命中 3 分、正文 2 分、其他字段 1 分、短语整词出现另加 5 分；按分数降序、同分按章节升序。分词也是同一套：中文重叠 bigram + 拉丁词 + 单字（高频虚字不作单字索引）。

### character_lookup — 按 id 取一条完整条目

| 参数 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 条目 id，如 `line-107-01`、`event-238`、`trait-04`、`profile` |

返回 `ok`、`found`、完整条目 `entry`（全部字段，另带 `_type`）。找不到时 `found: false`，附一句提示（先用 search 查到 id 再取），不抛错。

## 验证方法

```sh
cd character-db/dsh-plugin
npm test    # mock 测试：node test/mock-test.ts
npm run demo  # 真库 demo：node test/demo.ts
```

- mock 测试 20 项：工具注册与 JSON Schema 自检、工具-only（零监听、零 effect、零 systemPrompt.context 调用、一段静态工具说明 section 且 id 与内容正确）、检索与全部过滤器、lookup、空查询/非法参数报错、tokenCap 截断、坏 JSON 单文件跳过、缺失 dataDir 大声报错、只读（真库文件前后一致）。
- demo 在真库上跑 `绑架`、`考研`、`日记`、`姜萍` 四组查询 + 一次 `event-238` lookup，结果应与 `node query.mjs` 的排序一致（绑架前两条是 231–240 生死危机与 238 绑架；考研前两条是 217 图书馆与 262 初试 410 分；日记前两条是 ch.9 与 ch.109 的内心独白；姜萍前两条是 263、264 章）。
- 在 DSH 里验证：新开一个人设窗口，先说一句话触发 skill，再问一个只有原著细节能答的问题（例如“她 262 章考研考了多少分”），看模型是否调用 `character_search`，以及 `character-db` 是否出现在插件列表里。注意：**不要用“她还记得我说过什么吗”来验证**——那是记忆插件的活，人物数据库只管原著。

## 硬限制

- **工具-only，无自动注入**：插件往提示词里只放一段静态工具使用说明（见上节），从不注入任何条目、原著内容或回忆；模型不调用，库就不存在。
- **只读**：插件只读 `*.json`，不写数据库、不建文件、不改 skill。单个损坏的 JSON 文件会被跳过并警告，不会拖垮整个加载；dataDir 不存在、或一个可用条目都没有时，插件大声报错并拒绝加载（DSH 本身不受影响）。
- **不联网、不登录、无云端**：零运行时依赖；`@deepseek-ai/dsh-tools` 在 `link:` 安装下解析不到时，工具参数改由本地编译成 JSON Schema（与记忆插件同一套写法），模型可见的 schema 与真 defineTool 一致。
- **多人物靠换 dataDir**：schema 同一套，换目录即换角色。profile 的检索标签按文件自身的 `name` / `birth_name` 生成，不写死某一个角色的名字。
- **条目是意译**：库里没有任何原著原文，工具描述里也写明了不许当作原话引用、不许当作共同经历。真想核对原文请去翻小说，不要拿这个库当原文。

## 发布说明

当前只有本地路径安装。以后要发布时：需要一个构建步骤把 `@deepseek-ai/dsh-tools` 打进产物（`main` 现在直接指 `./src/index.ts`，供本地开发；发布包要 `tsc` 构建出 `index.js` + `lib/` 并经 `prepare` 挂接），其余与记忆插件的发布流程相同。发布前同样要做个人信息检查：本插件源码里不含任何个人信息。
