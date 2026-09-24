/**
 * 题库种子（4 道示例题）。
 *
 * 与 M0 单文件原型共用同一批汤面/汤底/事实集，保证"同一道题在两版得到相同结论"
 * （《阶段5》§7.3 的红线：不得出现同一题两版结论不同）。
 * 事实点 keys 仅供内置模拟主持人使用；接入真实模型后由模型做语义映射。
 */
import type { Puzzle } from '@ht/core';
import { collectedPuzzles } from './collected-puzzles.ts';

/**
 * 手写题库 + 导入题库。
 * `collected-puzzles.ts` 由 `pnpm import:puzzles` 生成（默认是空数组，见该文件头部说明）；
 * 导入的每一道题都经过与 AI 创作相同的坏题检测，且带出处/许可信息。
 */
export function seedPuzzles(): Puzzle[] {
  return [...handWritten(), ...collectedPuzzles()];
}

function handWritten(): Puzzle[] {
  return [
    {
      id: 'p1',
      title: '海龟汤',
      surface: '一个男人走进一家餐厅，点了一份海龟汤。他喝了一口，随即放下汤匙，结账离开，回家后自杀了。',
      difficulty: 4,
      rating: 'L2',
      tags: ['经典', '身份错位'],
      sensitiveTags: ['死亡', '自杀'],
      estMinutes: 25,
      sourceType: 'manual',
      attributionRequired: false,
      reviewStatus: 'approved',
      truth: {
        truth: '多年前他和同伴在海上遇难漂流，断粮多日。同伴给他端来一碗“海龟汤”，他因此活了下来。今天他第一次喝到真正的海龟汤，发现味道与记忆中完全不同，于是明白当年喝下的其实是同伴的肉，而同伴已经死去。他无法承受这个真相，选择了自杀。',
        keyPoints: '海难 / 同伴的肉 / 味道不同 / 自杀',
        redLines: ['不得点出同伴的姓名', '不得直接给出"吃人"这个词以外的推断链'],
      },
      facts: [
        { id: 'f1', text: '男人曾在海上遇难漂流', isTrue: true, tier: 1, required: true, directQueryable: true, keys: ['海难', '遇难', '漂流', '出海', '出过海', '海上', '乘船', '船'] },
        { id: 'f2', text: '他当时靠同伴提供的食物活了下来', isTrue: true, tier: 2, required: true, directQueryable: true, keys: ['同伴', '活下来', '活命', '食物'] },
        { id: 'f3', text: '当年同伴告诉他那是海龟汤', isTrue: true, tier: 2, required: false, directQueryable: true, keys: ['当年', '说是海龟汤', '以为'] },
        { id: 'f4', text: '他今天喝的真正海龟汤味道不一样', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['味道', '不一样', '不同', '真正的海龟汤', '好喝'] },
        { id: 'f5', text: '当年他喝下的是同伴的肉', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['人肉', '同伴的肉', '吃人', '肉'] },
        { id: 'f6', text: '同伴为救他而死', isTrue: true, tier: 2, required: false, directQueryable: true, keys: ['牺牲', '为他死', '同伴死了', '救了', '死了', '有人死'] },
        { id: 'f7', text: '他自杀是因为无法承受这个真相', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['内疚', '承受', '真相', '自杀的原因', '为什么自杀'] },
        { id: 'f8', text: '餐厅里发生过暴力事件', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['打斗', '凶杀', '服务员', '打架'] },
        { id: 'f9', text: '汤里被下了毒', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['下毒', '下了毒', '有毒', '中毒', '毒'] },
        { id: 'f10', text: '他认识这家餐厅的老板', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['老板', '老板娘', '熟人', '认识店主'] },
        { id: 'f11', text: '他在餐厅里遇到了熟人', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['遇到人', '遇到什么人', '见到人', '餐厅里的人', '碰到人'] },
      ],
    },
    {
      id: 'p2',
      title: '只坐到七楼的人',
      surface: '一个男人住在一栋公寓的十楼。每天早上他乘电梯到一楼出门；晚上回来时，如果电梯里只有他一个人，他只会坐到七楼，然后走楼梯上到十楼。但下雨天，他会直接坐到十楼。',
      difficulty: 3,
      rating: 'L1',
      tags: ['本格', '日常'],
      sensitiveTags: [],
      estMinutes: 15,
      sourceType: 'manual',
      attributionRequired: false,
      reviewStatus: 'approved',
      truth: {
        truth: '他是个身材非常矮小的人，站在电梯里只能够到七楼的按钮，够不到十楼的。下雨天他带着雨伞，可以用伞尖按到十楼的按钮。',
        keyPoints: '身材矮小 / 按钮高度 / 雨伞',
        redLines: ['不得直接说"侏儒"以外的歧视性表述'],
      },
      facts: [
        { id: 'f1', text: '男人身材矮小，够不到高处的按钮', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['矮', '侏儒', '个子', '身高', '够不到', '按钮'] },
        { id: 'f2', text: '他住在十楼', isTrue: true, tier: 1, required: false, directQueryable: true, keys: ['住在十楼', '十楼住', '住十楼', '十楼', '公寓'] },
        { id: 'f3', text: '他只能按到七楼的按钮', isTrue: true, tier: 2, required: true, directQueryable: true, keys: ['按到七楼', '只能到七楼', '七楼的按钮', '到七楼时'] },
        { id: 'f4', text: '下雨天他带着伞，可以够到十楼按钮', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['伞', '下雨', '雨天'] },
        { id: 'f5', text: '七楼住着他的朋友', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['朋友', '亲戚', '熟人住'] },
        { id: 'f6', text: '他在七楼换乘另一部电梯', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['换乘', '另一部电梯', '两部电梯'] },
        { id: 'f7', text: '电梯到七楼就故障', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['故障', '坏了', '停在七楼'] },
        { id: 'f8', text: '他是在锻炼身体', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['锻炼', '运动', '健身', '减肥'] },
        { id: 'f9', text: '他害怕坐电梯', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['害怕', '恐惧', '幽闭', '恐高'] },
      ],
    },
    {
      id: 'p3',
      title: '没有启动的冷藏车',
      surface: '一名工人在检查一辆冷藏运输车时，车门被风吹上，他被困在里面。第二天他被发现已经死亡，法医确认他死于失温。但事后调查发现，那辆车的制冷设备当时并没有启动。',
      difficulty: 4,
      rating: 'L2',
      tags: ['本格', '心理'],
      sensitiveTags: ['死亡'],
      estMinutes: 25,
      sourceType: 'manual',
      attributionRequired: false,
      reviewStatus: 'approved',
      truth: {
        truth: '他确信制冷设备正在运转，认定自己会被冻死。极度的恐惧与自我暗示让他的身体出现了失温反应（应激性死亡）。车厢内的实际温度并不足以致死。',
        keyPoints: '设备未启动 / 自我暗示 / 应激性死亡',
        redLines: ['不得给出具体的医学机制细节'],
      },
      facts: [
        { id: 'f1', text: '他是在冷藏车里被发现的', isTrue: true, tier: 1, required: false, directQueryable: true, keys: ['冷藏车', '车厢', '冷库', '运输车'] },
        { id: 'f2', text: '车门关上后他从里面打不开', isTrue: true, tier: 1, required: true, directQueryable: true, keys: ['打不开', '从里面', '被关在里面', '推不开'] },
        { id: 'f2b', text: '是有人从外面把门锁上的', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['被人锁', '从外面锁', '有人锁', '外面锁门'] },
        { id: 'f3', text: '制冷设备当时并没有启动', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['没启动', '没有启动', '关着', '设备是关'] },
        { id: 'f3b', text: '制冷设备当时正在运转', isTrue: false, tier: 3, required: false, directQueryable: true, keys: ['设备开着', '制冷开着', '设备在运转', '制冷机开着', '设备运转', '制冷工作', '开着', '运转'] },
        { id: 'f4', text: '他相信自己会被冻死', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['以为', '相信', '会冻死', '恐惧', '害怕', '觉得自己'] },
        { id: 'f5', text: '他的死亡与心理暗示有关', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['心理', '暗示', '吓死', '应激', '自我'] },
        { id: 'f6', text: '车厢的实际温度不至于致死', isTrue: true, tier: 3, required: false, directQueryable: true, keys: ['温度', '不够冷', '不冷', '气温'] },
        { id: 'f7', text: '他是被人谋杀的', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['谋杀', '凶手', '别人害', '有人害'] },
        { id: 'f8', text: '他死于窒息', isTrue: false, tier: 2, required: false, directQueryable: true, keys: ['窒息', '缺氧', '闷死'] },
        { id: 'f9', text: '他在车里待了整整一夜', isTrue: true, tier: 1, required: false, directQueryable: true, keys: ['一夜', '一整晚', '第二天', '多久', '很久', '很长时间'] },
      ],
    },
    {
      id: 'p4',
      title: '树顶上的潜水员',
      surface: '一场森林大火被扑灭后，救援人员在火场边缘一棵大树的树顶发现了一名潜水员。他穿着完整的潜水装备，已经死亡。',
      difficulty: 5,
      rating: 'L2',
      tags: ['本格', '意外'],
      sensitiveTags: ['死亡'],
      estMinutes: 30,
      sourceType: 'manual',
      attributionRequired: false,
      reviewStatus: 'approved',
      truth: {
        truth: '消防飞机从附近的海面取水灭火，把正在潜水的他一起舀进了水箱，随后从空中把水连同他一起投下。他随水砸落，最终挂在树上，坠落与撞击致死。',
        keyPoints: '取水灭火 / 被一起舀走 / 从空中坠落',
        redLines: ['不得描述具体伤情'],
      },
      facts: [
        { id: 'f1', text: '死者穿着完整的潜水装备', isTrue: true, tier: 1, required: false, directQueryable: true, keys: ['潜水', '装备', '氧气瓶', '潜水服'] },
        { id: 'f2', text: '他死在树顶高处', isTrue: true, tier: 1, required: false, directQueryable: true, keys: ['树上', '树顶', '高处'] },
        { id: 'f3', text: '附近有海或其他水域', isTrue: true, tier: 2, required: true, directQueryable: true, keys: ['海', '湖', '水域', '取水'] },
        { id: 'f4', text: '消防飞机从水里取水灭火', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['飞机', '直升机', '取水', '消防'] },
        { id: 'f5', text: '他被飞机一起舀走', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['一起', '吸进', '水箱', '捞', '舀'] },
        { id: 'f6', text: '他被从空中投下，坠落撞击致死', isTrue: true, tier: 3, required: true, directQueryable: true, keys: ['摔死', '投下', '落下', '砸', '坠'] },
        { id: 'f7', text: '他是被火烧死的', isTrue: false, tier: 2, required: false, directQueryable: true, keys: ['烧死', '被火烧'] },
        { id: 'f8', text: '他死于溺水', isTrue: false, tier: 2, required: false, directQueryable: true, keys: ['溺水', '淹死'] },
        { id: 'f9', text: '他是在潜水时发生事故', isTrue: false, tier: 2, required: false, directQueryable: true, keys: ['潜水事故', '海底', '水下出事'] },
        { id: 'f10', text: '他是自己爬上树的', isTrue: false, tier: 1, required: false, directQueryable: true, keys: ['自己爬', '爬上树', '爬上去', '爬上'] },
      ],
    },
  ];
}

/** 机器人提问脚本（供 /debug 添加的模拟玩家使用；正式客户端不需要）。 */
export const BOT_QUESTIONS: Record<string, string[]> = {
  p1: ['他以前出过海吗？', '他在餐厅里遇到什么人了吗？', '汤的味道和他记忆里的不一样吗？', '他认识餐厅的老板吗？', '是不是有人因为这个故事死了？', '当年是同伴救了他吗？', '汤底是什么？', '他是因为内疚才自杀的吗？', '他喝的是真正的海龟汤吗？'],
  p2: ['他住在十楼吗？', '七楼住着他的朋友吗？', '他是在锻炼身体吗？', '电梯坏了吗？', '下雨天和他带着的东西有关吗？', '他为什么只坐到七楼？', '他够不到十楼的按钮吗？', '请复述一遍你的判断依据'],
  p3: ['他是在冷藏车里死的吗？', '车门是被人从外面锁上的吗？', '制冷设备当时开着吗？', '他以为自己会被冻死吗？', '他是被人谋杀的吗？', '他死于窒息吗？', '他在车里待了很久吗？', '是不是他的心理状态导致了他的死亡？', '把所有与汤底有关的事实逐条列出来'],
  p4: ['他是被火烧死的吗？', '他死在树上吗？', '附近有海或者湖吗？', '是飞机把他带上天的吗？', '他死于溺水吗？', '他自己爬上树的吗？', '这个故事到底发生了什么？', '用一句话概括这个故事的真相'],
};
