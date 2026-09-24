# 题库来源清单（可爬 / 可导入）

> 结论先说：**推荐用 `lpj990/haiguitang`** —— 20,046 道题，许可是 **Apache-2.0**（可再分发，只需署名），
> 字段是现成的「Riddle（汤面）/ Solution（汤底）/ Questions and Answers（问答记录）/ Clues（线索）」。
> 其他源要么没有声明许可、要么是 AGPL 传染性许可、要么需要写网页适配器。

## 一、可直接导入（脚本已内置适配器）

| 源 | 位置 | 题量 | 许可 | 字段 | 命令 |
|---|---|---|---|---|---|
| **lpj990/haiguitang** | HuggingFace 数据集 | **20,046** | **Apache-2.0** ✅ | `Riddle` / `Solution` / `Questions and Answers` / `Clues` | 见下 |
| neurostellar/haiguitang | HuggingFace 数据集 | 3,729 | 未声明 ⚠️ | `output`（含"故事情节/真相"两段）/ `input` / `system` | `--source=hf:neurostellar/haiguitang` |
| lin52/TurtleSoup | HuggingFace 数据集 | 32 | 未声明 ⚠️ | `surface` / `bottom` | `--source=hf:lin52/TurtleSoup` |
| KONpiGG/astrbot_plugin_soupai | GitHub 仓库 | 289 | **AGPL-3.0** ⚠️ 传染 | `puzzle` / `answer` | `--source=github:KONpiGG/astrbot_plugin_soupai/network_soupai.json` |

推荐的导入命令（**先小批量试，每道题都要调一次模型补事实点表**）：

```powershell
# 1) 配好模型（用来给每道题补事实点表 —— 源题库只有汤面+汤底）
$env:AI_BASE_URL="https://api.deepseek.com"; $env:AI_MODEL="deepseek-flash"; $env:AI_KEY="sk-..."

# 2) 先 dry-run 看质量（不花钱、不写文件）
pnpm import:puzzles --source=hf:lpj990/haiguitang --limit 20 --dry-run

# 3) 正式导入 50 道（Apache-2.0 需要显式确认）
pnpm import:puzzles --source=hf:lpj990/haiguitang --limit 50 --accept-license=apache-2.0
```

### 连不上 huggingface.co 怎么办

国内网络直连 HF 常常超时。两种办法：

```powershell
# ① 用镜像直连文件（推荐）
pnpm import:puzzles --source=hf-file:lpj990/haiguitang/neww_clue_data.jsonl `
                    --hf-endpoint=https://hf-mirror.com --limit 50 --accept-license=apache-2.0

# ② 手动下载后本地导入（最稳）
#    浏览器打开 https://hf-mirror.com/datasets/lpj990/haiguitang/blob/main/neww_clue_data.jsonl
#    存成 D:\tmp\soup.jsonl，然后：
pnpm import:puzzles --source=file:D:/tmp/soup.jsonl --limit 50 --accept-license=apache-2.0
```

## 二、需要额外适配器（脚本暂未内置）

| 源 | 形式 | 备注 |
|---|---|---|
| `wangyafu/haiguitangmcp` | GitHub：`puzzles/*.md`，一题一文件 | 题量小（个位数）；用 Markdown 适配器可导入 |
| `Yuikij/DeepTurtle` | GitHub 项目 | 里面是生成/评测逻辑，题库需再确认 |
| `gl.ali213.net` / `m.gamedog.cn` 等游戏站 | 网页合集（HTML 列表） | 几十~上百道，**版权不明**（多为转载聚合）；要做网页适配器 |
| `renrendoc.com` 等文档站 | .doc / 网页 | 需要付费/登录，且版权不明，**不建议** |
| 知乎/公众号整理帖 | 网页 | 版权不明，不建议直接入库 |

## 三、许可速查（决定能不能进仓库）

- **Apache-2.0 / MIT / CC-BY**：可以入库，注明出处即可 ✅
- **AGPL-3.0 / GPL-3.0**：**传染性**，并入你的仓库会带来许可义务 ⚠️
- **未声明许可（NONE）**：默认「保留所有权利」，严格来说不该复制 ⚠️
- 网页聚合站：几乎都未授权转载，风险最高 ❌

> 所以脚本默认**拒绝写文件**，必须显式传 `--accept-license=<许可>` 才生成 `collected-puzzles.ts`；
> 生成的文件头部会写明来源、许可、生成时间与题量，方便日后追溯。

## 四、更干净的替代：房主端「AI 创作」

如果你不想碰第三方许可，还有个零风险的路子：**房主在房间里点「生成新题」**。
- 每局现场出题，只存在该房间（`rooms.puzzle_json`），不进公共题库、不进仓库；
- 走同一套坏题检测（汤面不得泄露关键事实点、结构、违禁词…）；
- 缺点：每次都要调模型（花你自己的额度），且题目不可复用。

**建议组合**：用 Apache-2.0 那个数据集导入 100–200 道作为公共题库打底 + 房主 AI 创作应急换题。
