/**
 * 主力前端（「深夜档案桌」）的静态契约测试。
 *
 * 这组断言把《前端设计方案》§2 的风格禁区与 §25 里**可以静态验证**的条目钉住：
 * 它们曾经只写在文档里，靠人肉检查；现在改坏了会直接测试失败。
 * 文件是 `packages/web/public/index.html`（M6 之后它就是主力版）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN = 'packages/web/public/index.html';
const CLASSIC = 'packages/web/public/classic/index.html';

const read = (p: string): string => readFileSync(join(root, p), 'utf8');
/** 只看样式表，避免把注释里的字眼当成违规 */
const styleOf = (html: string): string => {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, '应当有内联样式表');
  return m[1] ?? '';
};

test('F1: 风格禁区 —— 没有背景模糊、没有装饰性渐变、没有 emoji 图标', () => {
  const css = styleOf(read(MAIN));
  assert.ok(!/backdrop-filter/.test(css), '不允许玻璃拟态（backdrop-filter）');
  assert.ok(!/blur\(/.test(css), '不允许模糊');
  // 只允许"桌面纤维"纹理（设计稿 §2.6 给出的两条 linear-gradient），不得出现径向霓虹光斑
  assert.ok(!/radial-gradient/.test(css), '不允许径向渐变光斑');
  const gradients = css.match(/gradient/g) ?? [];
  assert.ok(gradients.length <= 4, `渐变只能用于桌面纹理，实际出现 ${gradients.length} 处`);
  // 纸张/弹窗/吸底书写板之外的阴影一律不要
  const shadows = (css.match(/box-shadow/g) ?? []).length;
  assert.ok(shadows <= 5, `box-shadow 只允许出现在纸张/弹窗/吸底处，实际 ${shadows} 处`);

  const html = read(MAIN);
  const emoji = html.match(/[\u2300-\u27BF\u2B00-\u2BFF\uFE0F\uD83C-\uDBFF\uDC00-\uDFFF]/g) ?? [];
  const allowed = new Set(['↓', '←']);                       // 设计稿明确使用的新消息/返回箭头
  const bad = emoji.filter((c) => !allowed.has(c));
  assert.deepEqual(bad, [], `界面图标必须是自绘线性 SVG，不允许 emoji：${bad.join(' ')}`);
});

test('F2: 三栏骨架、页签、书写板与关键控件 id 都在', () => {
  const html = read(MAIN);
  for (const need of ['class="grid"', 'col-side', 'col-main', 'col-rail', 'speakerbox', 'puzzle-card', 'records', 'composer', 'tabs', 'btnTabCrew', 'btnTabNotes', 'toasts']) {
    assert.ok(html.includes(need), `结构缺少：${need}`);
  }
  // 动作绑定靠这些 id，改名就要同步改处理函数 —— 用测试兜住
  for (const id of ['id="ask"', 'id="btnSend"', 'id="chatInput"', 'id="btnChatSend"', 'id="btnReady"', 'id="btnGuessQuick"', 'id="btnGuessSubmit"', 'id="btnCfg"', 'id="btnCfgApply"', 'id="btnKey"', 'id="btnRecap"', 'id="btnLeave"']) {
    assert.ok(html.includes(id), `缺少控件：${id}`);
  }
});

test('F3: 文案用中文，不把内部枚举暴露给玩家', () => {
  const html = read(MAIN);
  assert.ok(html.includes('等待开局') && html.includes('推理进行中') && html.includes('本局结束'), '阶段要有人话文案');
  // roomStatusLabel 必须是映射，而不是直接渲染 room.status
  assert.ok(/function roomStatusLabel/.test(html), '应当有阶段文案映射函数');
  assert.ok(!/\$\{esc\(room\.status\)\}/.test(html), '不允许把 waiting/playing/settled 直接渲染出来');
});

test('F4: 会话与草稿的本地键（升级不该把正在玩的人弄丢）', () => {
  const main = read(MAIN);
  assert.ok(main.includes("const LS_TOKEN = 'ht.token';"), '主力版沿用 ht.token');
  assert.ok(main.includes("const LS_DRAFT = 'ht.draft';"), '主力版沿用 ht.draft');
  const classic = read(CLASSIC);
  assert.ok(classic.includes("const LS_TOKEN = 'ht.classic.token';"), '旧版要隔离到 ht.classic.*');
  assert.ok(!classic.includes("const LS_TOKEN = 'ht.token';"), '旧版不得再抢主力版的会话键');
});

test('F6: 同一个功能只留一个入口（不重复堆放按钮）', () => {
  const html = read(MAIN);
  // 猜汤底：只在底部书写板（btnGuessQuick）出现一次；工具条里不再有第二个
  assert.ok(html.includes('id="btnGuessQuick"'), '底部书写板要有猜汤底');
  assert.ok(!html.includes('id="btnGuess"'), '工具条里不该再有第二个猜汤底（曾重复）');
  // 讨论：桌面靠右栏页签，窄屏才用入口按钮 —— 按钮必须带 btnchat（桌面 display:none）
  assert.ok(/id="btnChatOpen" class="btnchat/.test(html), '窄屏讨论入口按钮要带 btnchat 类（否则桌面上会与右栏页签重复）');
  assert.ok(html.includes('id="btnTabNotes"'), '右栏要有讨论页签');
  // 房间信息与设置：只保留左栏「ROOM / 房间」卡片，顶栏不再重复一个入口
  assert.ok(!html.includes('btnRoomInfo'), '顶栏不该再有房间信息入口');
  assert.ok(!html.includes('btnCfgQuick'), '工具条里不该再有第二个对局参数（左栏已有）');
  assert.ok(html.includes('HOST / 房主操作'), '房主操作集中在左栏卡片里');
});

test('F7: 入场动画只加在新条目上（否则每次重渲染都会闪一遍）', () => {
  const css = styleOf(read(MAIN));
  assert.ok(/\.chat \.msg\.fx\{animation/.test(css), '便笺动画必须挂在 .fx 上');
  assert.ok(/\.log \.tl\.fx,\.log \.qa\.fx\{animation/.test(css), '记录动画必须挂在 .fx 上');
  assert.ok(!/\.chat \.msg\{animation/.test(css), '不允许把动画直接挂在 .msg 上（重渲染会重播）');
  assert.ok(!/\.log \.tl\{animation/.test(css), '不允许把动画直接挂在 .tl 上');
  const html = read(MAIN);
  assert.ok(/fxLogAt|fxChatSeq/.test(html), '渲染时要记录"已经见过的最新一条"，才能判断谁是新的');
  // 被推迟的补渲染不能强制重画（指纹没变就一个字节都别动）
  assert.ok(/if \(S\.renderPending && !isBusy\(\)\) render\(\);/.test(html), '补渲染必须用非强制 render()');
});

test('F5: 设计令牌齐备且可访问性规则在位', () => {
  const css = styleOf(read(MAIN));
  for (const token of ['--desk-950', '--paper-100', '--brass', '--stamp-yes', '--stamp-no', '--font-story', '--font-mono', '--focus']) {
    assert.ok(css.includes(token), `缺少设计令牌：${token}`);
  }
  assert.ok(/:focus-visible/.test(css), '焦点必须可见');
  assert.ok(/prefers-reduced-motion/.test(css), '必须尊重 reduced-motion');
  assert.ok(/min-height:44px/.test(css), '窄屏触控目标至少 44px');
  assert.ok(/@media\(max-width:900px\)/.test(css), '必须有窄屏断点');
});

