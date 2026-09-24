# 题库来源清单（可爬 / 可导入）

> 一句话结论：
> · **要质量** → `Narcissuses/Turtle-Bench`（ModelScope，**Apache-2.0**，563 道独立题，全是经典题，繁体）
> · **要数量** → `lpj990/haiguitang`（HuggingFace，**Apache-2.0**，20,046 行 → **18,815 道可用**，AI 生成、质量参差）
> · **要零风险** → 房主端「AI 创作」（不进仓库、不碰第三方许可）

## 一、实测过的可用源（脚本已内置适配器）

| 源 | 位置 | 规模 | 许可 | 质量 | 命令 |
|---|---|---|---|---|---|
| **Narcissuses/Turtle-Bench** | ModelScope（国内快，200ms 级） | 9,457 行 = **563 独立题**（每题约 18 条「猜测+对错标签」） | **Apache-2.0** ✅ | **高**：经典题、汤底完整、0 条灵异/猎奇误伤；繁体 | `--source=modelscope:Narcissuses/Turtle-Bench/train_8k.json` |
| **lpj990/haiguitang** | HuggingFace | **20,046 行 = 18,815 可** | **Apache-2.0** ✅ | 中：AI 批量生成，逻辑常不闭合，混灵异/性暴力/猎奇 | `--source=hf:lpj990/haiguitang` |
| neurostellar/haiguitang | HuggingFace | 3,729 | 未声明 ⚠️ | 中：`output` 里混着"故事情节/真相"两段 | `--source=hf:neurostellar/haiguitang` |
| lin52/TurtleSoup | HuggingFace | 32 | 未声明 ⚠️ | 中 | `--source=hf:lin52/TurtleSoup` |
| KONpiGG/astrbot_plugin_soupai | GitHub | 289 | **AGPL-3.0** ⚠️ 传染 | 未知 | `--source=github:KONpiGG/astrbot_plugin_soupai/network_soupai.json` |

**支持的源语法**：`file:<本地 JSON/JSONL>` · `modelscope:<ns>/<name>/<path>` · `hf:<dataset>` · `hf-file:<dataset>/<path>`（可配镜像） · `github:<owner>/<repo>/<path>` · `https://…json`

## 二、看过但**不建议用**的源（附原因）

| 源 | 为什么不建议 |
|---|---|
| ModelScope `Brain_teasers`（↓1779，许可 other） | 是**脑筋急转弯**（文字游戏/谐音梗），不是情境推理；我们的规则明确禁止"靠谐音、歧义当唯一谜底" |
| ModelScope `naojingjizhuanwan`（Apache-2.0） | 同上，体裁不对 |
| ModelScope `IQuiz`、`RiddleBench`、`altered-riddles`、`riddle_sense` | 英文谜语 / 通识评测集，不是中文海龟汤 |
| GitHub `wangyafu/haiguitangmcp` | 题库是 `puzzles/*.md` 一题一文件，量极小（个位数） |
| 游戏站 `gl.ali213.net`、`m.gamedog.cn`、文档站 `renrendoc.com` | 网页合集，**版权不明**（多为未授权转载），且需要写网页适配器 |
| 知乎/公众号整理帖 | 同上，版权不明 |

## 三、许可速查

- **Apache-2.0 / MIT / CC-BY**：可入库，注明出处 ✅（前面两个大源都是 Apache-2.0）
- **AGPL-3.0 / GPL-3.0**：传染性 ⚠️ 并入你的仓库会带来许可义务
- **未声明（NONE）**：默认保留所有权利 ⚠️
- 网页聚合站：几乎都未获授权 ❌

> 脚本默认**拒绝写文件**，必须显式 `--accept-license=<许可>` 才生成 `collected-puzzles.ts`；
> 生成文件头部会写清来源 / 许可 / 时间 / 题量。

## 四、推荐操作顺序

```powershell
# 0) 配好模型（每道题要调一次，用来补事实点表）
$env:AI_BASE_URL="https://api.deepseek.com"; $env:AI_MODEL="deepseek-flash"; $env:AI_KEY="sk-..."

# 1) 先体检，看清质量（不花钱）：Turtle-Bench 只有 563 独立题，适合全量
pnpm analyze:puzzles --source=modelscope:Narcissuses/Turtle-Bench/train_8k.json

# 2) 导入 Turtle-Bench（繁体会自动转简体；只导通过质检的）
pnpm import:puzzles --source=modelscope:Narcissuses/Turtle-Bench/train_8k.json `
                    --accept-license=apache-2.0 --limit 100

# 3) 数量还不够，再从 HuggingFace 那 2 万题里补（先用体检挑出零风险的那批）
pnpm analyze:puzzles --source=hf-file:lpj990/haiguitang/neww_clue_data.jsonl `
                     --hf-endpoint=https://hf-mirror.com --dump
pnpm import:puzzles --source=file:data/candidates.jsonl --accept-license=apache-2.0 --limit 100
```

**建议**：先用 Turtle-Bench 那 499 道经典题打底（质量优先），不够再从 2 万题里按体检结果补。

## 五、额外收获：Turtle-Bench 可以当**判定评测集**

它的每行是 `{surface, bottom, user_guess, label}`，`label` 是 T/F/N（这条猜测对不对）。
这意味着我们可以拿它做一次**端到端回归**：把 `user_guess` 当玩家提问喂给我们的判定引擎，
看引擎给出的 是/否 是否与 `label` 一致 —— 这是现成的、带标注的判准集，比自己造题靠谱得多。
（想做的话我可以加一个 `pnpm eval:judge` 脚本。）
