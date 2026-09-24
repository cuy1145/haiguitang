# 题库来源清单

> **已导入的库**：`Narcissuses/Turtle-Bench`（ModelScope）→ **325 道**已进仓库，见 `packages/server/src/data/collected-puzzles.ts`。
> 想加题就重跑导入脚本 → `git push`，CI 会自动部署（题库是**编译进 Worker 的常量**，不在数据库里）。

## 一、当前用的源

| 源 | 位置 | 规模 | 许可 | 说明 |
|---|---|---|---|---|
| **Narcissuses/Turtle-Bench** | ModelScope（国内 200ms 级） | 9,457 行 = **563 道独立题** | **Apache-2.0** ✅ | 经典题、汤底完整；**繁体**；自带 `user_guess + label`（判定评测集） |
| KONpiGG/astrbot_plugin_soupai | GitHub | 289 | **AGPL-3.0** ⚠️ 传染 | 如需使用请自行判断许可义务 |

**已移除**：HuggingFace（`lpj990/haiguitang` 等）—— 国内直连基本不通，镜像也时好时坏，已从脚本和文档中删掉。
原始数据仍可从 <https://hf-mirror.com/> 手动下载后走 `--source=file:` 导入，但不再作为推荐路径。

**支持的源语法**：`file:<本地 JSON/JSONL>` · `modelscope:<ns>/<name>/<path>` · `github:<owner>/<repo>/<path>` · `https://…json`

## 二、本次导入的过程与结果（可复现）

```powershell
# 1) 抓源（也可先用浏览器从 ModelScope 下载到 data/ 再走 file:）
pnpm analyze:puzzles --source=modelscope:Narcissuses/Turtle-Bench/train_8k.json   # 体检，不花钱

# 2) 导入（规则版事实点，**不需要 API Key**）
pnpm import:puzzles --source=modelscope:Narcissuses/Turtle-Bench/train_8k.json `
                    --facts=rule --accept-license=apache-2.0
```

实际数字（train + test 合并去重后）：

| 阶段 | 数量 |
|---|---|
| 原始记录 | 9,457 行 |
| 独立题目（汤面+汤底去重） | 563 |
| 文本级质检通过（内容干净） | 550 |
| 汤底 ≥20 字（去掉"一句话答案"填充题） | ~500 |
| 能拆出 ≥2 条事实点且结构合规 | **325** |

**被拒的原因分布**：繁体高风险内容（灵异/性暴力/猎奇）、汤底过短、只有 1 条事实点、含超自然谜底。

## 三、事实点是怎么来的（`--facts=rule` 的关键）

网上题库只有「汤面 + 汤底」，而我们的判定引擎需要**事实点表**。两种来源：

1. `--facts=rule`（**默认、零成本**）：汤底拆句当成立事实；若数据源自带 `user_guess + label`，
   则 **T 标签的猜测 → 成立事实**、**F 标签的猜测 → 否定型事实**（"玩家真猜过、但本题不成立"）。
   Turtle-Bench 正好有这套标签，所以免模型也能建出可判定的题。
2. `--facts=ai`（需要 `AI_KEY`，质量更好）：调模型拆原子事实，并**顺带把繁体转成简体**。

> 因此当前导入的 325 道是**繁体**。想让它们变简体并细化事实点：
> ```powershell
> $env:AI_BASE_URL="https://api.deepseek.com"; $env:AI_MODEL="deepseek-flash"; $env:AI_KEY="sk-..."
> # 清空 collected-puzzles.ts 后重跑（脚本对本库去重，清空才会重新生成）
> pnpm import:puzzles --source=file:data/turtle-bench-all.json --facts=ai --license=apache-2.0 --accept-license=apache-2.0
> ```

## 四、许可速查

- **Apache-2.0 / MIT / CC-BY**：可入库，注明出处 ✅（导入的文件头会自动写来源/许可/时间/题量，题目里也带"题库来源"字段，前端会显示）
- **AGPL-3.0 / GPL-3.0**：传染性 ⚠️
- **未声明**：默认保留所有权利 ⚠️
- 网页聚合站（ali213、gamedog、renrendoc、知乎/公众号）：几乎都未获授权 ❌

脚本默认**拒绝写文件**：必须显式 `--accept-license=<许可>`（本地文件源另加 `--license=<许可>`）才生成。

## 五、看过但没采用的源

| 源 | 不用的原因 |
|---|---|
| ModelScope `Brain_teasers`、`naojingjizhuanwan` | **脑筋急转弯**（谐音梗/文字游戏），不是情境推理；规则明确禁止"靠谐音歧义当谜底" |
| `IQuiz`、`RiddleBench`、`altered-riddles`、`riddle_sense` | 英文谜语 / 通识评测集 |
| GitHub `wangyafu/haiguitangmcp` | `puzzles/*.md` 一题一文件，只有个位数 |
| HuggingFace 全部 | 国内不可达（已移除） |
| 游戏站 / 文档站 / 知乎整理帖 | 版权不明，需另写网页适配器 |

## 六、意外收获：Turtle-Bench 还能当判定评测集

它的每行是 `{surface, bottom, user_guess, label}`，`label` 是 T/F/N（这条猜测对不对）。
可以拿它做**端到端回归**：把 `user_guess` 当玩家提问喂给判定引擎，看引擎的 是/否 是否与 `label` 一致。
这是现成的、带标注的判准集 —— 想要的话可以加个 `pnpm eval:judge` 脚本。
