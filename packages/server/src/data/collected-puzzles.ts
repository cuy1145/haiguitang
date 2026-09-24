/**
 * 导入题库（由 `pnpm import:puzzles` 生成）。
 *
 * 默认是**空的** —— 这样仓库里不含任何第三方题库数据，许可干净。
 * 想导入时在本机跑一次生成脚本（需要你自己的模型 Key）：
 *
 *   pnpm import:puzzles --source=github:KONpiGG/astrbot_plugin_soupai/network_soupai.json \
 *                       --accept-license=AGPL-3.0 --limit 60
 *
 * 只有显式传入 --accept-license 才会写入本文件；生成物会带上出处与许可注释。
 *
 * ⚠️ 关于许可：`astrbot_plugin_soupai` 的题库是 **AGPL-3.0**。
 *    把它的数据并入你的仓库会带来 AGPL 的传染性义务；如果你不希望这样，
 *    就不要运行导入脚本，改用「房主端 AI 创作」（每个房间现场出题、不落库）。
 */
import type { Puzzle } from '@ht/core';

/** 导入的题目（当前为空） */
export function collectedPuzzles(): Puzzle[] {
  return [];
}
