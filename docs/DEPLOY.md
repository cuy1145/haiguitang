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
| **Durable Objects** | ❌ **免费计划不可用（需付费）** → 已改为 D1 方案，见 `docs/CF-WITHOUT-DO.md` |
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
   | `Account` | `Durable Objects` | `Edit` |
   | `Account` | `Account Settings` | `Read` |

   > 第 2 行（Durable Objects）**不能少**：模板里的 "Edit Cloudflare Workers" 不包含它，这是本项目必须自建 Token 的原因。
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

`wrangler whoami` 输出里应当能看到 `Account Name`、`Account ID`，以及一段权限列表（包含 Workers Scripts、Durable Objects）。
如果提示 `not authenticated` 或权限列表里缺 Durable Objects，就回到第 5 步补权限重新建。

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

# 3) 可选：站点内置额度用的 Key（不配也能玩，会用内置模拟主持人做判定）
npx wrangler secret put AI_KEY
npx wrangler secret put AI_BASE_URL       # 例如 https://api.deepseek.com/v1
npx wrangler secret put AI_MODEL          # 例如 deepseek-chat

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
| Actions 里 deploy 报 `Authentication error [code: 10000]` | `CLOUDFLARE_API_TOKEN` 缺失/权限不足 | 按 2.3 重新生成，权限必须含 `Workers Scripts: Edit` 与 `Durable Objects: Edit` |
| deploy 报 `Cannot apply new_sqlite_classes` 或迁移冲突 | 之前用 `new_classes` 建过同名 DO | 本项目从未部署过就正常；若已部署过，改 `[[migrations]]` 的 tag 或删除旧的 DO 命名空间 |
| `wrangler dev` 起不来，提示 workerd 缺失 | pnpm 拦截了安装脚本 | `package.json` 里已声明 `pnpm.onlyBuiltDependencies`，执行 `pnpm install` 即可 |
| 页面能打开但一直"断开，正在重连" | WebSocket 被拦，或 DO 报错 | 看 `wrangler tail` 的 `ws_connected` / `do_http_error`；企业网络可能拦 WS |
| 提交提问后一直"主持人判定中" | 未配 `AI_*` 时用的是内置模拟主持人（应瞬间返回）；说明 DO 抛错 | `wrangler tail` 看 `judge_failed` / `ws_frame_error` |
| 房主提交 Key 报 `VAULT_DISABLED` | 没设置 `MASTER_KEY` | `npx wrangler secret put MASTER_KEY`（32 字节 base64） |
| 房主提交 Key 报 `AUTH_FAILED` | Key 无效/被撤销 | 在提供方后台确认 Key 与余额，再重新提交 |
| 免费额度告警 | 请求数或 DO 时长超限 | 提高 tick 间隔、减少日志；或升级 Workers Paid（$5/月） |

---

## 6. 我需要你提供的信息（都不含密钥）

1. GitHub 仓库地址（形如 `https://github.com/你/haiguitang`）——用于我帮你核对 remote 与 Actions 配置
2. Cloudflare 的 **workers.dev 子域**（形如 `abc-xyz.workers.dev`）——用于写进验收清单
3. 你是否愿意把仓库设为 **Public**（默认按 Private 处理）

**不要**把 `CLOUDFLARE_API_TOKEN`、`MASTER_KEY`、`AI_KEY` 发给我或任何聊天窗口。
如果哪天不小心发了，请立刻在对应后台作废并重新生成。

