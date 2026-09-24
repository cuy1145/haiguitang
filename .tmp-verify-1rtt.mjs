/** 临时验收：动作响应是否自带 view/questions（省掉一次往返） */
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
async function call(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}
const post = (path, payload, headers = {}) => call(path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
});

for (let i = 0; i < 40; i++) {
  try { const r = await call('/api/health'); if (r.status === 200) break; } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 1000));
  if (i === 39) { console.error('FAIL: dev server 没起来'); process.exit(1); }
}

const A = await post('/api/rooms', { nickname: '房主A', preset: 'quick' });
const auth = { authorization: `Bearer ${A.body.token}` };
const B = await post(`/api/rooms/${A.body.code}/join`, { nickname: '玩家B' });

// 1) 动作响应自带 view
const readyRes = await post('/api/rooms/actions', { type: 'ready', ready: true }, auth);
console.log('ready →', readyRes.status, 'keys:', Object.keys(readyRes.body).join(','));
console.log('   view.room.readyCount =', readyRes.body.view?.room?.readyCount, '| questions =', Array.isArray(readyRes.body.questions) ? readyRes.body.questions.length : 'n/a');

// 2) 未全员准备 → 失败响应也带 view（前端可直接渲染错误后的状态）
const denied = await post('/api/rooms/actions', { type: 'start', mode: 'pick' }, auth);
console.log('start(denied) →', denied.status, denied.body.error, '| 带 view =', Boolean(denied.body.view));

// 3) 全员准备 + 开局
await post('/api/rooms/actions', { type: 'ready', ready: true }, { authorization: `Bearer ${B.body.token}` });
const started = await post('/api/rooms/actions', { type: 'start', mode: 'pick' }, auth);
console.log('start(ok) →', started.status, 'ok =', started.body.ok, '| status =', started.body.view?.room?.status);

// 4) 提交提问：响应里应立刻带上新的公共记录（不用再轮询）
const turnSeq = started.body.view.room.turn.seq;
const submit = await post('/api/rooms/actions', { type: 'submit', turnSeq, text: '他是因为看到了什么才这样做的吗？', clientSubmitId: 'c1' }, auth);
console.log('submit →', submit.status, 'ok =', submit.body.ok, '| questions =', submit.body.questions?.length, '| 首条 =', JSON.stringify(submit.body.questions?.[0]?.text));

const ok = readyRes.body.view && Array.isArray(readyRes.body.questions)
  && denied.body.view
  && started.body.view?.room?.status === 'playing'
  && submit.body.questions?.length >= 1;
console.log(ok ? 'VERIFY OK' : 'VERIFY FAIL');

await post('/api/rooms/actions', { type: 'leave' }, auth);
await post('/api/rooms/actions', { type: 'leave' }, { authorization: `Bearer ${B.body.token}` });
process.exit(ok ? 0 : 1);
