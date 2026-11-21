# NewQA · 本地问答笔记

跑在本机的问答笔记本，目标是替代日常 `devin` CLI 用法：
和**当前已登录的 Devin CLI** 对话（ACP stdio 协议），可对回答划词
「标注」（彩色、纯本地）或「追问」（支线，发给 summarizer agent）。
所有会话只存在浏览器 localStorage，不上传、不写文件。

## 启动

```bash
npm install
npm run build    # 构建前端到 dist/
npm start        # http://127.0.0.1:4173/（PORT 可覆盖）
```

**必须先 `npm run build`**：服务端只托管 `dist/`（同源、无 CORS）。
开发改前端可用 `npm run dev`（Vite 5173，不带后端接口）。

### WSL + Windows 盘

- Vite 已开启 `watch.usePolling`；
- 从 Windows 浏览器打开 <http://127.0.0.1:4173/>。如果 Windows 到 WSL 的 localhost
  转发不可用，可使用 IDE 端口转发；服务只绑定回环地址，不能直接用 WSL 网卡 IP 访问。

## 两种回合

| | 主线（底部输入框） | 支线（划词「追问」） |
| --- | --- | --- |
| kind | `work` | `discussion` |
| agent | `devin acp`（默认 agent） | `devin acp --agent-type summarizer`（无工具） |
| 会话 | 原生 `session/new` / `session/load` 续聊 | 每轮全新会话，客户端回放上下文 |
| 上下文 | Devin 侧原生记忆 | JSON envelope：历史 + 引用选段 + 问题 |
| 工具/权限 | 工具事件上屏 + 权限决策卡片 | 无工具；权限一律自动拒绝 |
| git 快照 | 回合成功后只读收集 | 不收集 |

- **work**：`initialize` → `session/new`（或已有 `sessionId` → `session/load`）
  → 每个 prompt 前 `session/set_mode {modeId:'accept-edits'}`（失败即终止，fail closed）
  → `session/prompt`。完成后返回原生 `sessionId` 存到会话上，下一轮跨进程
  `session/load` 原生续聊（**不做历史回放**，前端也不再重发 history）。
  加载失败给可见错误，不会偷换新会话。

> ⚠️ **工作模式下，Devin 可直接编辑工作区内文件**（`accept-edits` 等价于 CLI 的
> `--permission-mode accept-edits`；实测 `ask` 是只读 profile，只读不能改，不符合
> 工作模式预期，故不用）。只有 Devin 发出权限请求的动作才会弹窗，
> 不会自动替你批准弹窗——本 UI 也不声称能拦截每一次写操作。
- 旧版浏览器存档的会话没有 `sessionId`：首个 work 回合走 `session/new` 并用
  envelope 回放历史，之后正常原生续聊。
- **discussion**：忽略 sessionId，summarizer 无工具，适合围绕选段的隔离追问；
  兄弟支线、锚点之后的内容不会混入上下文。

> 注意：work 回合若在 Devin 侧被中断/中止，原生会话里**可能**已留下不完整的
> 记录（这是 Devin 行为）；浏览器转录只提交 `end_turn` 的完整回合，
> 未完成的一律丢弃且保留你的草稿。

## 权限与工具

- **权限模式**（每会话独立，主输入区分段控件）：`标准`（accept-edits，编辑
  自动、命令类动作需确认）/ `智能`（smart，Devin 自行判断安全的动作）/
  `全部放行`（bypass，所有工具自动批准、不再弹窗确认）。切到「全部放行」
  先弹风险确认，生效期间输入区常驻红色徽标；切换**下一回合生效**
  （回合进行中禁用控件），服务端对每个 work 请求调 `session/set_mode`
  透传 modeId，仅接受白名单三值（其余一律 400），讨论模式不使用。
  ⚠️ 全部放行意味着 Devin 可在该工作区执行任意命令、修改文件、访问
  网络而不向你确认——只对信任的任务与工作区开启。
- 工具事件（`tool_call` / `tool_call_update`）归一化后随回合持久化：
  `{id,title,kind,status,command,output,locations}`，`command` 只取
  `rawInput.command|cmd`（≤4000 字，其余 rawInput 字段一律不透出）；
  output 只取 agent 上报的文本，有界截断，按纯文本展示
  （终端输出若 agent 未上报会标注「未上报」）。标题为空或 `call_*` 原始
  ID 时界面显示「工具调用」，原始值保留在 title 属性。
- 权限请求弹出决策卡片：**只有「允许一次/拒绝一次」**，过滤掉
  `allow_always` / `reject_always` / bypass；卡片展示标题、kind 与
  命令文本（若 agent 在 rawInput 里提供）；多个待决请求**只渲染最旧一张**，
  附「还有 N 个待确认」，逐个决策依次顶上。服务端校验 optionId 属于本轮实际
  提供的选项，超时/错 id 404、无效选项 400，**绝不自动批准**。回合结束或中止时
  未决请求统一以 `cancelled` 答复 agent。ACP 运行时若不问权限，本应用也无从拦截。
- work 回合成功后用 `execFile`（无 shell、`GIT_OPTIONAL_LOCKS=0`、4s 超时、
  输出截断）收集 `git status --short` / 未暂存与已暂存 diff，随回合持久化展示；
  非 git 仓库标注不可用。**快照包含仓库既有改动，并非全由 Devin 产生**；
  未跟踪文件只列名不读内容。本应用不提供任何让用户直接跑 shell 的接口。

## 斜杠命令与模型配置

- **斜杠命令面板**（仅主输入框）：输入 `/` 开头的第一个 token 时弹出
  `devin acp` 命令清单（aria-combobox，↑/↓ 移动，Enter/Tab 接受为
  `/{name} ` 并保留其后文本，Esc 关闭，点击亦可）。文本**原样发送**，
  由 Devin 自己解析命令；NewQA 只提供候选。命令清单来自
  `GET /api/devin/options` 的只读探测（`initialize` → `session/new` →
  收集 `available_commands_update`，**不发送 prompt**，≤15s 超时 → 502，
  成功结果缓存 5 分钟，失败不写缓存）。
  ⚠️ 已知边界：非原生续聊的回合会把历史/引用/问题包进 JSON envelope
  （新会话首个 work 回合除外），此时 `/命令` 只是 envelope 里的普通文本，
  Devin **不会**当命令解析——斜杠命令只在原生 work 会话里可靠生效
  （即首个 work 回合之后；支线/discussion 回合永远走 envelope，不弹面板）。
- **会话级 模型/思考/速度**（主输入区三个下拉）：每会话独立选择，
  「默认」（空值）跟随 Devin 全局配置
  （`~/.config/devin/config.json` 的 model/thought/speed），选项与当前默认值
  来自同一 `/api/devin/options` 探测（取 `session/new` 的 `configOptions`
  中 `model`/`thought_level`/`speed` 三项）。选择立即持久化到会话、
  **对下一回合生效**（回合进行中禁用）；探测失败整行禁用并标「不可用」。
  服务端在每个 work 回合的 `session/set_mode` **之前**对非空键逐个调
  `session/set_config_option {sessionId, configId, value}`（RPC 失败即终止，
  fail closed，不发 prompt）；discussion 回合忽略该字段。
  `/api/chat` 只接受 `model`/`thought_level`/`speed` 三键、≤128 字符串，
  其余一律 400。

## 标注 / 支线 / 导航

- 划词弹出「四色标注 / 添加备注 / 追问」：色块只做高亮（无内联卡片），
  「添加备注」才在右侧导航打开编辑器（已有同锚点标注则直接编辑它）。
  CSS Custom Highlight 上屏，写了笔记的标注加下划线；不支持的浏览器降级为块级色条。
- 备注只在右侧导航编辑/改色/删除（纯本地，不发送）；索引点标注跳到对应源块。
- 支线面板：显示选段 + 「支线 #N」（**会话全局**编号，深度优先按锚点序分配）、
  收起/展开、二次确认删除；五色轮换（蓝/绿/琥珀/玫瑰/薰衣草），
  相邻兄弟与父子不同色，嵌套支线各有自己的编号与色。
- 右侧导航（ChatIndex 式）：头部 ⇤/⇥ 折叠钮 + `问/注/追` 计数；桌面折叠为
  ~34px 图标条（问 chip / 标注色点 / 💬，均可点击跳转）。展开为按「问」分组的
  可折叠树：组头 问+问题+注/追徽章，标注行（色点+引文或笔记）与支线行
  （`#N` 同色徽标+「追问：引文」）沿引导线缩进，支线内递归嵌套。
  点击跳转转录（展开祖先、滚至顶部约 12%、闪烁）；右键或 Shift+F10 在
  标注/支线行弹菜单（编辑备注 / 删除标注 / 删除追问，删除两段确认）。
  转录右缘导航点同样可跳。
- 主题：顶栏 ☀/☾ 切换白/深，localStorage `newqa:theme` 持久化。

## 布局与工作区

- 左栏按工作区分组：顶部「＋ 新对话」建未分组会话；「工作区 ＋」打开
  **文件夹选择器**（本机目录浏览 `POST /api/workspace/browse`，只列子目录、
  不读文件内容；支持逐级进入/上级/手输绝对路径，「选择此文件夹」经
  `/api/workspace/inspect` 校验后注册）。重复注册只展开分组；新注册且该目录
  无会话时自动开一个；每组有「在该目录新建对话」。空路径会话归入「未分组」。
  主输入区工作区条同样可「浏览文件夹」（锁定会话除外）。
  分组折叠状态、侧栏宽度/折叠持久化在 `newqa:layout`。
- 会话行有 ⋯ 菜单：**重命名**（≤80 字，`titleCustomized` 阻止自动改名）与
  **删除对话**（弹窗确认；只删本地转录/标注，不动工作区文件与 Devin 原生会话；
  生成中的对话须先停止）。
- 两侧栏桌面可独立折叠（顶栏 «/»）并可拖拽或方向键调整宽度
  （左 180–360 / 右 220–440，中央至少留 360px）；≤960px 走抽屉遮罩，
  打开备注编辑器会自动展开右抽屉。
- 会话数据存 `localStorage` 键 `newqa:v1`（含 `workspaces` 注册表；
  旧存档自动兼容）；损坏时顶部提示并备份为 `newqa:v1:corrupt`。
- 工作区：会话可绑定一个**绝对路径**目录；留空用服务启动目录（`/api/status` 的
  `defaultCwd`，页面标注「默认」）。**完成首个回合后锁定**，换目录请开新对话。
  spawn 永远带显式 cwd，`session/new`/`session/load` 传同一值，不改进程全局 cwd。
- 回答遵循你当前 `devin auth` 登录态与模型；本应用不新增/不读取任何 API Key，
  不记录 prompt，不向外发 stderr/环境信息。
- 服务端只绑 127.0.0.1，校验 Host/Origin 一致性、JSON-only、1 MiB 上限、
  单回合串行（并发 409）、history ≤200 条、字段长度受限、无路径遍历。
  `browse` 只返回目录名/路径（跳过隐藏项、符号链接与文件，上限 4096 扫描/256 返回）。

## 已验证 / 未验证

已验证（`npm test`，91 项 node:test + jsdom DOM）：

- work 调用顺序 `initialize → session/new|load → set_mode(accept-edits) → prompt`；
  `session/load` 续聊不回放历史、前端不重发 history、回放更新不上屏；
  load/set_mode 失败 fail closed。
- `set_config_option` 按提供的非空键逐个下发且在 `set_mode` 之前，
  空键/缺省不下发、RPC 错误 fail closed；`/api/devin/options` 探测归一化
  （commands + 三项 config，过滤其余 configId）与 5 分钟缓存/失败不缓存；
  `modelConfig` 三键白名单校验（未知键/非字符串/超长 → 400）。
- discussion 用 `--agent-type summarizer`、忽略 sessionId 与 modelConfig、
  权限自动拒绝。
- 工具事件归一化、权限决策全生命周期（无自动批准、404/400）、git fixture
  快照（应用不写文件）、workspace/sessionId/kind 校验、静态遍历、413/415/403/409。
- DOM（jsdom + React act，mock 全部 /api）：`/co` 过滤面板、Enter/Tab 接受
  `/compact `、Esc 关闭、aria-combobox；模型三下拉选项/默认文案/选择持久化
  与重挂载恢复、work 请求体带 modelConfig、支线 discussion 不带、
  pending 禁用、≤960px 窄视口不破版式。
- 浏览器：文件夹选择器（浏览/上级/手输/选择）、会话重命名持久化与删除确认、
  工作区分组注册/去重/折叠持久化、纯标注无内联卡片、「添加备注」右栏编辑器、
  支线全局五色轮换（嵌套≠父色）、对话导航树结构与跳转、
  双面板折叠与拖拽/键盘 resize、窄屏抽屉与对话框；
  标注持久化/支线位置/历史回放 envelope、主题持久化、
  拦截的权限流程、工具与 git 展示。

未验证 / 注意：

- **未跑过真实 `session/prompt`**（避免付费调用）；`session/load`、
  `session/set_mode`、权限/工具事件的真实字段名以 ACP 文档与假进程测试为准，
  真机差异可能需要微调归一化。
- load 回放与 prompt 流式的边界按「load 响应先于 prompt 发出」假设；
  极端情况下回放残尾理论上可能漏进流式（未见实例）。
- 支线仍是「客户端回放」，Devin 侧工具/文件状态不延续。

## 结构

```
index.html  vite.config.js
src/App.jsx       全部 UI（会话/转录/标注/支线/索引/权限卡/工作区/
                  斜杠命令面板/模型下拉/主题）
src/model.js      数据模型与纯函数（historyFor、不可变更新、存档解析、
                  modelConfig、buildChatBody）
src/slash.js      斜杠命令面板纯函数（token 判定/前缀过滤/接受替换）
src/markdown.js   markdown-it + 顶层块切分
src/styles.css    白/深双主题
server/acp.mjs    ACP 客户端（work/discussion、load/set_mode、
                  set_config_option、probeOptions、权限/工具钩子）
server/index.mjs  HTTP 服务（静态 + /api/chat、/api/chat/permission、
                  /api/workspace/inspect、/api/workspace/browse、
                  /api/devin/options、/api/status；git 只读快照）
test/*.test.mjs   node:test 测试（dom.test.mjs 经 jsx-loader + jsdom
                  驱动真实 App 组件）
```
