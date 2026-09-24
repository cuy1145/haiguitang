# 部署配置指南（GitHub + Cloudflare，零基础版）

> 目标：把本项目部署到 **Cloudflare Workers（免费计划）**，源码托管在 **GitHub**，并让 GitHub Actions 自动部署。
>
> **分工**：下面标 🧑 的步骤必须由你本人操作（涉及登录、授权、密钥）；标 🤖 的已经由我完成或在移植完成后由我执行。
> **可以并行**：本文件的第 1、2 部分（账号与仓库配置）**现在就能做**，不需要等我把 Cloudflare 移植做完。

---

## 0. 先看这一屏：整体流程

**你的当前进度**（2026-09-23 实测）：

| 项 | 状态 |
|---|---|
| Cloudflare 账号 | ✅ 已登录（Account ID `cc4c2dfb7c9cf38819d09cae71ab7d0f`） |
| `wrangler login` | ✅ 已完成（OAuth Token 已存到本机） |
| GitHub 仓库 | ✅ 已建：<https://github.com/cuy1145/haiguitang> |
| 本地 git remote | ✅ 已配置 `origin` |
| **Durable Objects** | ❌ 免费计划不可用（需付费）→ **已按方案 A 改为 D1**，见 `docs/CF-WITHOUT-DO.md` |
| **D1 数据库** | ✅ 已创建 `haiguitang`（id `201c8906-63dd-4b55-9678-0f568c76fb57`），迁移已在本地应用 |
| **Worker 基础层** | ✅ 本地实测：health 真实查 D1 通过、静态资源 200、未完成端点 501 |
| **workers.dev 子域** | ❌ **未注册 —— 任何部署都必需，见 §2.0** |
| Cloudflare API Token | ⬜ 可选（只为 GitHub Actions 自动部署；本地部署不需要，见 §2.3） |
| Worker 移植 | ⬜ 我这边收尾中（`packages/worker/README.md`） |

```
⓪ 注册 workers.dev 子域（必须先做，30 秒）
    ↓
① GitHub 建仓库 → ② 推送代码 → ③ 配置 2 个仓库 Secret（可选，给自动部署用）
    ↓
④ Cloudflare 建 API Token + 记下 Account ID（可选）→ ⑤ 本地 wrangler login（✅ 已完成）
    ↓
⑥ 我完成 CF 移植（library-do.ts + 端到端验证）
    ↓
⑦ 设置运行期密钥（MASTER_KEY / 可选 AI_KEY）→ ⑧ 首次部署 → ⑨ 两台设备试玩
```

预计你本人需要花的时间：**20～30 分钟**（主要是注册后的点选与复制粘贴）。

> ⚠️ **安全纪律（务必先读）**
> - **不要把任何 API Key、Token、MASTER_KEY 贴到聊天窗口、截图或 issue 里**。凡是需要密钥的地方，都通过
>   GitHub 的 Secrets 界面或 `wrangler secret put` 输入。
> - 本项目的密钥红线是"只进不出"：服务端加密存储、界面只显示掩码、日志全脱敏。
>   一旦某个密钥曾经出现在聊天/截图/公开仓库里，就当作已泄露，**立刻在提供方后台作废并重新生成**。
> - `.env` / `.dev.vars` 已在 `.gitignore` 中，不会被提交；请不要手动 `git add -f` 它们。

---

## 1. 🧑 GitHub 配置

### 1.1 创建仓库

1. 打开 <https://github.com/new>
2. **Repository name**：`haiguitang`
3. **Visibility**：建议先选 **Private**（私人娱乐项目；想公开也完全可以，代码里没有密钥）
4. **不要**勾选 "Add a README file" / ".gitignore" / "license"（本地已经有代码，勾了反而要先合并）
5. 点 **Create repository**

创建完成后页面会显示这个仓库的地址，形如：
`https://github.com/<你的用户名>/haiguitang.git` —— 把 `<你的用户名>` 换成你自己的，后面要用。

### 1.2 把本地代码推上去

代码我已经在本地提交好了（分支名 `main`，提交 `c32f028`）。在项目目录执行（把 URL 换成你的）：

```powershell
cd "D:\test 小项目\海龟汤\haiguitang"
git remote add origin https://github.com/<你的用户名>/haiguitang.git
git push -u origin main
```

**推送时会要求登录**，两种方式任选其一：

- **推荐（最省事）**：Windows 版 Git 会弹出浏览器窗口让你用 GitHub 账号授权，点同意即可。
- 如果没弹窗、或提示输入用户名密码：密码位置要填 **Personal Access Token（PAT）**，不是账号密码。
  生成方式：GitHub → 右上角头像 → **Settings** → 左侧最下 **Developer settings** →
  **Personal access tokens** → **Fine-grained tokens** → **Generate new token**：
  - Repository access：**Only select repositories** → 选 `haiguitang`
  - Permissions → Repository permissions → **Contents: Read and write**
  - 有效期建议 90 天，生成后**立刻复制**（只显示一次），粘贴到密码提示处

推送成功后刷新仓库页面，应该能看到 `README.md`、`packages/`、`wrangler.toml` 等文件。

### 1.3 配置仓库 Secrets（自动部署用）

路径：仓库页面 → **Settings** → 左侧 **Secrets and variables** → **Actions** → **New repository secret**

| 名称 | 值 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2.3 步生成的 Token | 用于 GitHub Actions 部署 |
| `CLOUDFLARE_ACCOUNT_ID` | 第 2.2 步记下的 Account ID | —— |

再点 **Variables** 标签页 → **New repository variable**（可选，但建议配，用于部署后自动健康检查）：

| 名称 | 值 | 说明 |
|---|---|---|
| `WORKER_URL` | 例如 `https://haiguitang.<你的子域>.workers.dev` | 首次部署后才知道，可稍后回来补 |

> 这两个值都不是"能直接读取代码"的凭据吗？——`CLOUDFLARE_API_TOKEN` **是**凭据，必须放在 Secrets 里；
> `CLOUDFLARE_ACCOUNT_ID` 不是敏感信息，但放 Secrets 也无妨。

---

## 2. 🧑 Cloudflare 配置

### 2.0 注册 workers.dev 子域（**必须先做**）

没有子域时，任何 `wrangler deploy` 都会失败并提示：

```
X [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.toml file,
          or register a workers.dev subdomain here:
          https://dash.cloudflare.com/<你的 Account ID>/workers/onboarding
```

**操作**：

1. 打开 <https://dash.cloudflare.com/cc4c2dfb7c9cf38819d09cae71ab7d0f/workers/onboarding>
   （或：Dashboard → 左侧 **Workers & Pages** → 按引导走）
2. 它会要求你**选一个子域前缀**，完整域名就是 `<前缀>.workers.dev`
   - 只能用字母/数字/连字符，例如 `haiguitang-cuy1145`
   - 这个前缀是**账号级**的，之后所有 Worker 默认都挂在它下面（本项目会得到 `https://haiguitang.<前缀>.workers.dev`）
   - 名字不涉及隐私（它只会出现在你的网址里），但**选个自己记得住的**；虽然官方允许改，但改了老网址会失效
3. 点确认完成注册（免费计划同样可以注册）
4. 回到项目目录重试部署即可

> 注册完成后告诉我，我会立刻重跑那个 Durable Object 探针，实测三件事：
> ① 免费计划能否创建 **SQLite 后端**的 DO；② DO SQLite 持久化是否跨请求生效；③ **alarm** 能否在无请求时自行触发。
> 这三条都通过，才说明架构选型在这个账号上成立。

### 2.1 确认计划与 Durable Objects 可用性

1. 登录 <https://dash.cloudflare.com>
2. 左侧 **Workers & Pages** → 如果是第一次用，会引导你设置一个 **workers.dev 子域**（例如 `abc-xyz.workers.dev`），照着设置即可
3. 本项目需要 **Durable Objects（SQLite 后端）**。配置里用的是 `new_sqlite_classes`（免费计划可用的形态）；
   KV 后端的新命名空间已被 Cloudflare 停止支持，所以不要改成 `new_classes`
4. 顺手确认一下当前限额（部署前建议核对，页面里数字可能随官方调整而变化）：
   - Durable Objects Limits：<https://developers.cloudflare.com/durable-objects/platform/limits/>
   - Workers Limits：<https://developers.cloudflare.com/workers/platform/limits/>
   - Workers 定价/免费额度：<https://developers.cloudflare.com/workers/platform/pricing/>
   - WebSocket 休眠：<https://developers.cloudflare.com/durable-objects/best-practices/websockets/>

> 说明：我的沙箱把 `developers.cloudflare.com` 解析到非公网地址，取不到这些页面，所以上面列了链接给你核对。
> 实现上我已按"免费计划可用"做保守设计：tick 间隔 1 秒、单次 tick 只做纯计算与少量 SQL、DO 可休眠时不计时长。

### 2.2 拿到 Account ID

- 方式 A（网页）：<https://dash.cloudflare.com> → 右侧栏 **Account ID**，点复制
- 方式 B（命令行，需先做 2.4 登录）：`npx wrangler whoami`

### 2.3 创建 API Token（给 GitHub Actions 用）

> **先明确一件事**：如果你只想**先把网站跑起来**，这一步可以跳过。
> 你已经执行过 `npx wrangler login`，直接在本地 `pnpm cf:deploy` 就能上线。
> API Token **只为让 GitHub Actions 自动部署**而存在（以后 push 一次就自动发布）。

**点击路径（逐屏对照）**

1. 打开 <https://dash.cloudflare.com/profile/api-tokens>
   （也可以从右上角头像 → **My Profile** → 左侧 **API Tokens** 进入）
2. 点右上/中间的 **Create Token** 按钮
3. 页面上半部分是模板（Templates），**别点那些**。拉到底部找到 **Custom token** 区块 → 点 **Get started**
4. **Token name** 填：`haiguitang-deploy`
5. **Permissions** 是这次的重点。每一行是「三个下拉框」，点右侧 **+ Add more** 可以加行。共需要 **3 行**：

   | 第 1 个下拉（作用域） | 第 2 个下拉（资源） | 第 3 个下拉（权限级别） |
   |---|---|---|
   | `Account` | `Workers Scripts` | `Edit` |
   | `Account` | `D1` | `Edit` |
   | `Account` | `Account Settings` | `Read` |

   > 第 2 行（D1）**不能少**：本项目状态全存在 D1 里（方案 A，不用 Durable Objects），
   > 模板里的 "Edit Cloudflare Workers" 不包含它，这是本项目必须自建 Token 的原因。
   > 权限级别必须是 `Edit`，`Read` 会导致部署报 `Authentication error [code: 10000]`。

6. **Account Resources**：选 `Include` → 右侧下拉选你的账号名（通常只有一个）
7. **Zone Resources**：本项目用 `*.workers.dev`，**不需要任何 Zone 权限**，保持默认即可（不要选域名）
8. **Client IP Address Filtering** / **TTL**：
   - IP 过滤留空（家里/公司网络会变）
   - TTL 建议设一个到期日（例如 1 年后），到期重新生成即可
9. 点 **Continue to summary** → 核对三行权限没问题 → 点 **Create Token**
10. **立刻复制**这串 Token（形如 `abcdefg...`，只在这一次显示，关掉页面就再也看不到）

**粘贴到哪里**

- 第 1.3 步的仓库 Secret：名称必须**逐字**是 `CLOUDFLARE_API_TOKEN`
- 不要粘贴到 `wrangler.toml`、任何文件、聊天窗口或截图里
- 如果哪一步复制丢了：不用找回，直接再建一个 Token 并删掉旧的（API Tokens 页面每行右侧有 **Delete**）

**验证 Token 是否正确（可选，推荐）**

在项目目录执行下面两行 —— `Read-Host` 的输入不会进入命令历史，也不会写进任何文件：

```powershell
$env:CLOUDFLARE_API_TOKEN = Read-Host "粘贴 Token 后回车"
npx wrangler whoami            # 会打印账号名 + 这个 Token 拥有的权限列表
Remove-Item Env:CLOUDFLARE_API_TOKEN
```

`wrangler whoami` 输出里应当能看到 `Account Name`、`Account ID`，以及一段权限列表（包含 Workers Scripts、D1）。
如果提示 `not authenticated` 或权限列表里缺 D1，就回到第 5 步补权限重新建。

> 部署工作流里已经加了"先 `whoami` 再 deploy"的步骤：万一 Token 配错，Actions 日志会直接打印它实际拥有的权限，
> 而不是等到部署失败才看不出来。


### 2.4 本地登录（首次部署走这条路最简单）

```powershell
cd "D:\test 小项目\海龟汤\haiguitang"
npx wrangler login          # 会打开浏览器，点 Allow
npx wrangler whoami         # 确认已登录，并显示 Account ID
```

### 2.5 等你把上面做完，告诉我进度

我这边同时在做「把服务端移植到 Workers + Durable Objects」的收尾（`packages/worker/README.md` 里有待办清单）。
**移植完成前执行部署会失败**（缺少 Library DO），所以第 3 步之前请等我一句"可以部署了"。

---

## 3. 🤖 设置运行期密钥并首次部署（移植完成后）

```powershell
# 1) 生成主密钥（用于加密房主自备的 API Key；32 字节 base64）
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

# 2) 写入 Cloudflare（不会显示在终端历史里，也不会进仓库）
npx wrangler secret put MASTER_KEY        # 粘贴上一步生成的值

# 3) 可选：站点内置额度用的 Key（**不配也能玩真实模型**——房主在页面里填自己的 Key 即可）
npx wrangler secret put AI_KEY
npx wrangler secret put AI_BASE_URL       # 例如 https://api.deepseek.com
npx wrangler secret put AI_MODEL          # 例如 deepseek-flash

# 判定用哪个 Key（凭据优先级，见 packages/server/src/ai.ts 的 judge）：
#   ① 房主在「我的 API Key」里提交的自备 Key（加密存储，用完即弃，优先级最高）
#   ② 站点 Key（上一条 AI_KEY；受 SITE_MONTHLY_CALL_CAP 月度上限约束）
#   ③ 两者都没有 → 内置模拟主持人（关键词表驱动，能玩但不理解自然语言）
# 也就是说：**服务端完全不配 AI_* 也能打出真实模型对局**，只要房主自己填 Key。
# 房主填完后可在弹窗里点「测试连接（不入库）」先验证 Key 是否可用。

# 4) 本地先跑一遍（本地 workerd，不需要账号也能验证功能）
Copy-Item .dev.vars.example .dev.vars     # 然后把 MASTER_KEY / AI_* 填进去
pnpm cf:dev                                # 打开提示的 http://localhost:8787

# 5) 部署到线上
pnpm cf:deploy

# 6) 观察线上日志（排查用；免费计划有额度限制）
pnpm cf:tail
```

部署成功后会打印形如 `https://haiguitang.<你的子域>.workers.dev` 的地址。把这个地址填到第 1.3 步的
`WORKER_URL` 变量里，之后每次推送到 `main` 都会自动部署 + 健康检查。

---

## 4. 验收清单（部署后逐条过）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 打开 `https://<你的地址>/` | 出现海龟汤首页（黄条提示 + 昵称输入框） |
| 2 | 打开 `https://<你的地址>/api/health` | `{"ok":true,"runtime":"cloudflare-workers",...}`，`db` 完整性正常 |
| 3 | 电脑 A 建房、电脑 B（或手机）输房间码加入 | 双方成员列表一致，网页底部显示"已连接" |
| 4 | 房主开局 → 双方轮流提问 | 只有轮到自己时才能发送；超时会被跳过并广播 |
| 5 | 故意晚 5 秒提交（宽限期内） | 提交成功且被标记为临界提交 |
| 6 | 在一台设备上关掉网页 30 秒再打开 | 会自动重连并拉到最新状态（被跳过的回合不补回） |
| 7 | 房主关闭网页超过 90 秒 | 房主位移交给下一位，额度来源变为"平台备用"，原 Key 显示"已挂起" |
| 8 | 对局结束后看复盘 | 能看到汤底与完整提问记录；中途"结束本局"的对局**看不到汤底** |
| 9 | 浏览器 DevTools → Network/WS | 任何响应与帧里都搜不到 `sk-` 形态的字符串 |
| 10 | `npx wrangler tail` 看日志 | 日志里没有汤底原文、没有 Key、没有 token |

---

## 5. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `git push` 提示 403 / Authentication failed | 用的密码不是 PAT，或 PAT 权限不够 | 重新生成细粒度 PAT，权限 `Contents: Read and write` 并勾选该仓库 |
| Actions 里 deploy 报 `Authentication error [code: 10000]` | `CLOUDFLARE_API_TOKEN` 缺失/权限不足 | 按 2.3 重新生成，权限必须含 `Workers Scripts: Edit`、`D1: Edit`（本项目状态存 D1，不用 Durable Objects） |
| deploy 报 D1 绑定/迁移相关错误 | 数据库 id 写错，或 token 缺 `D1: Edit` | 核对 `wrangler.toml` 的 `database_id`；迁移用 `npx wrangler d1 migrations apply haiguitang --remote` |
| `wrangler dev` 起不来，提示 workerd 缺失 | pnpm 拦截了安装脚本 | `package.json` 里已声明 `pnpm.onlyBuiltDependencies`，执行 `pnpm install` 即可 |
| 页面能打开但一直"断开，正在重连" | 轮询被拦（代理/企业网络）或 D1 报错 | 看 `wrangler tail` 的 `GET /api/rooms/state` 状态码；`/api/health` 里的 `db.ok` 是否为 true |
| 提交提问后判定结果明显"答非所问" | 没有可用的模型凭据，用的是内置模拟主持人（关键词表，只能识别题库里写过的说法） | 房主点「我的 API Key」填入自备 Key（先点「测试连接」验证），或运维配置 `AI_*` 平台额度 |
| 对局被中断，原因码 `SCHEMA_INVALID` | 模型没有按 JSON 回答。**DeepSeek 的思考模式默认开启**（effort=high），思维链会吃掉 `max_tokens`，导致正文为空/截断 | 已自动处理：对 DeepSeek 端点显式关闭思考模式并把 `max_tokens` 提到 400。若仍出现，换一个模型名后重新提交 Key（提交成功会自动解除暂停） |
| 房主修好 Key 后对局还卡在"等待房主处理" | 旧版本提交 Key 不会解除 `ai_blocked` | 已修复：提交成功即恢复对局；也可点提示条里的「更新 API Key 并继续对局」 |
| 提交提问后一直"主持人判定中" | 模型调用卡住/上游无响应 | `wrangler tail` 看 `judge_call_failed` / `judge_failed`（超时 20 秒即中断并暂停对局） |
| 房主提交 Key 报 `VAULT_DISABLED` | 没设置 `MASTER_KEY` | `npx wrangler secret put MASTER_KEY`（32 字节 base64） |
| 房主提交 Key 报 `AUTH_FAILED` / `MODEL_OR_BASE_URL_NOT_FOUND` | Key 无效，或地址/模型名不对 | 点弹窗里的「测试连接（不入库）」看具体原因与真实请求地址；DeepSeek 用 `https://api.deepseek.com` + `deepseek-flash` |
| 免费额度告警 | 请求数超限 | 提高轮询间隔（前端 1.8 秒）、减少日志；或升级 Workers Paid（$5/月） |

---

## 5.1 怎么看后台记录（出问题先看这里）

按「从快到慢」的顺序：

```powershell
# ① 实时日志（最常用）：判定来源、AI 中断、AI 出题、踢人、清理都会打在这里
pnpm cf:tail
#    关注这几条：
#      judge_result              — 判定成功（含 credit_source: host_key / site_fallback）
#      judge_call_failed         — 上游调用失败（errorClass：HTTP_401 / HTTP_429 / CONNECT_TIMEOUT…）
#      judge_output_parse_failed — 模型没给出可解析 JSON（带 finish_reason 与预览；预览已过汤底泄露检查）
#      ai_puzzle_created / ai_puzzle_rejected — 房主 AI 出题的结果
#      member_kicked             — 房主移出玩家

# ② 历史记录速查（一次看完审计/用量/提问/凭据/时间线）
pnpm audit              # 走线上 D1
pnpm audit --local      # 走本地 wrangler dev 的库
pnpm audit --tail 50    # 多看几行
pnpm audit --sql        # 只打印 SQL，自己拿去改着查
```

Cloudflare 面板里对应位置：

| 想看什么 | 位置 |
|---|---|
| 实时/最近日志 | Workers & Pages → `haiguitang` → **Logs** |
| 请求量与错误率 | Workers & Pages → `haiguitang` → **Metrics** |
| 数据库内容 | Storage & Databases → **D1** → `haiguitang` → **Console**（可直接写 SQL）|
| 定时任务 | Workers & Pages → `haiguitang` → Settings → **Trigger Events → Cron** |
| 运行期密钥 | Workers & Pages → `haiguitang` → Settings → **Variables**（只看得到名字）|
| CI/CD 执行 | GitHub → **Actions** → 选 workflow → 点进 job 看步骤日志 |

最常用的三条 SQL（也可以直接粘进 D1 Console）：

```sql
-- 最近发生了什么（含被拒原因、AI 中断、踢人、AI 出题）
SELECT datetime(ts/1000,'unixepoch','localtime') AS at, action, subject, result, room_id
FROM audit_events ORDER BY ts DESC LIMIT 30;

-- 这个月用了多少额度（site=平台额度 / host=房主自备 / mock=内置模拟）
SELECT period, scope, calls, blocked_count, grants_count FROM usage_counters ORDER BY period DESC;

-- 每一次提问与判定（source 告诉你这条是模型/缓存/规则给的）
SELECT datetime(created_at/1000,'unixepoch','localtime') AS at, room_id, turn_seq, answer, source, late, text, explain
FROM questions ORDER BY created_at DESC LIMIT 30;
```

> 汤底与密钥**永远不会**出现在日志或这些表里：日志里的模型输出预览会先过泄露检查（与汤底重合就整段打码），
> 凭据表里只有掩码（形如 `sk-****8191`）与指纹。

---

## 5.2 怎么修改目前的「后台」（改代码 / 改配置 / 改题库）

线上只有三块东西，**改法各不相同**：

| 你想改什么 | 改哪里 | 怎么生效 |
|---|---|---|
| 游戏规则、界面、接口 | 仓库源码（`packages/`） | `git push` → GitHub Actions 自动部署（约 2 分钟） |
| 表结构 | `packages/worker/migrations/000N_*.sql` | 同上；部署流程会自动 `d1 migrations apply` |
| 题库 | `packages/server/src/data/*.ts`（含导入生成的 `collected-puzzles.ts`） | 同上（题库是**编译进 Worker 的常量**，不在数据库里） |
| 平台额度 / 开关（`AI_KEY`、额度上限…） | Cloudflare 的 Secret / `wrangler.toml` 的 `[vars]` | Secret 改完立即生效；`[vars]` 需要重新部署 |
| 域名 / 静态资源 | `wrangler.toml` 的 `[assets]` | 重新部署 |

**日常改代码的完整流程**（本地能跑通再推）：

```powershell
# 1) 本地改代码
pnpm cf:dev                # 本地起服务（workerd + 本地 D1），浏览器打开提示的地址试玩

# 2) 本地验证（和 CI 跑的是同一套）
pnpm typecheck             # 类型检查
pnpm test                  # 107 个测试
node scripts/selfcheck.ts  # 工程自检（含"Worker 可打包性"等硬门槛）
pnpm analyze:puzzles ...   # 可选：改题库前先体检

# 3) 推送 → 自动部署
git add -A
git commit -m "说明这次改了什么"
git push                   # CI 跑验证 → 应用 D1 迁移 → wrangler deploy → 健康检查

# 4) 确认
#    GitHub → Actions 里看两个 workflow 是否都绿
#    https://haiguitang.luowanx70636.workers.dev/api/health
```

**改数据库结构**（加字段/加表）：

```powershell
# 1) 新建迁移文件（编号递增，只追加、不改历史文件）
#    packages/worker/migrations/0005_xxx.sql
# 2) 本地先应用并自测
npx wrangler d1 migrations apply haiguitang            # 本地
# 3) 推送后由 CI 自动应用到线上（部署流程里有这一步）
#    也可以手动：npx wrangler d1 migrations apply haiguitang --remote
```

**改题库**：

```powershell
# 方式 A：让房主在房间里用「AI 创作」现出一题（不进题库、零许可风险）
# 方式 B：导入第三方题库（见 docs/PUZZLE-SOURCES.md）
@'
import type { Puzzle } from '@ht/core';
export function collectedPuzzles(): Puzzle[] { return []; }
'@ | Set-Content packages/server/src/data/collected-puzzles.ts     # 先清空才重新生成
pnpm import:puzzles --source=modelscope:Narcissuses/Turtle-Bench/train_8k.json --facts=rule --accept-license=apache-2.0
pnpm seed && pnpm test     # 自检 + 测试
git add -A; git commit -m "题库：导入 N 道"; git push
```

**改运行期密钥 / 开关**：

```powershell
npx wrangler secret put AI_KEY          # 平台额度（可选；不配则由房主自备 Key 或内置模拟主持人）
npx wrangler secret put MASTER_KEY      # 保险箱主密钥（已配；换了会让已有房主 Key 失效）
npx wrangler secret list                # 只看得到名字，看不到值
# 额度上限之类的非敏感开关：改 wrangler.toml 的 [vars] 后 git push
```

**出问题怎么回滚**：

```powershell
git revert <坏的提交> && git push      # 或
git reset --hard <上一个好提交> && git push --force   # 谨慎使用
# Cloudflare 侧也可以在 Workers → Deployments 里直接回滚到上一个版本
```

**排查入口**：`pnpm cf:tail`（实时日志）· `pnpm audit`（历史记录速查）· 详见本文 §5.1。

---

## 6. 我需要你提供的信息（都不含密钥）

1. GitHub 仓库地址（形如 `https://github.com/你/haiguitang`）——用于我帮你核对 remote 与 Actions 配置
2. Cloudflare 的 **workers.dev 子域**（形如 `abc-xyz.workers.dev`）——用于写进验收清单
3. 你是否愿意把仓库设为 **Public**（默认按 Private 处理）

**不要**把 `CLOUDFLARE_API_TOKEN`、`MASTER_KEY`、`AI_KEY` 发给我或任何聊天窗口。
如果哪天不小心发了，请立刻在对应后台作废并重新生成。


