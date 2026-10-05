// 淘宝「开具发票」页（invoice-ua.taobao.com/e-invoice/invoice-apply-online.html?orderId=…&channel=card…）和提交后的
// 「发票详情」页（invoice-detail-tm.html?orderId=…）。用户 2026-10-05 示范：旺旺里点卖家开票卡片的「去申请」→ 新标签页打开本页
// →「提交申请」（A.m-submit）→ 弹出确认 →「确认提交」（DIV.m-submit）→ 跳到发票详情页。抬头、税号是账号里默认的，打开后约 2 秒才加载出来。
//
// 只在主页排了这单（cardJobs[订单号]，带过期时间，用户在主页确认过清单）时才动手：
//   1. 网址里的 orderId 必须是任务里的订单号（卡片归错单时打开的是别的单，不提交）
//   2. 至少等 2 秒，并等到页面上出现设置里的抬头（最多约 15 秒）；页面上写着税号的，也要和设置一致
//   3. 完整点击「提交申请」（页面按钮只认 按下→抬起→click 整套）→ 等确认弹窗 → 完整点击「确认提交」
//   4. 跳到发票详情页（或页面出现成功字样）后记 cardApplied[订单号]、cardResult[订单号]，关掉本页
// 核对不过就停下，面板上写明原因，不提交；原因写进 cardResult，主页提示后关掉本页。
// 淘宝官方客服给的「填写开票申请」卡片（extension/vip.js 会点）如果打开的也是本页（channel 不同），同样按 cardJobs 处理——待真实页面验证
(() => {
  if (window.top !== window || window.__otCard) return;
  window.__otCard = 1;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const squash = s => String(s || '').replace(/\s+/g, '');
  const vis = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const fullClick = b => { for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, view: window })); };
  // 文字正好是这几个字的最里层可见元素（真实页面是 A.m-submit / DIV.m-submit）
  const btn = re => [...document.querySelectorAll('a, button, div, span')].filter(e => vis(e) && re.test(text(e)) && ![...e.children].some(c => re.test(text(c)))).pop();
  const orderId = new URL(location.href).searchParams.get('orderId') || '';
  const onDetail = /invoice-detail/.test(location.pathname);
  if (!/^\d{15,20}$/.test(orderId)) return;

  // 扩展存储里的几份表：读出、改、写回要一个接一个
  let chain = Promise.resolve();
  const patch = (key, fn) => (chain = chain.then(async () => {
    const cur = (await chrome.storage.local.get(key))[key] || {};
    await chrome.storage.local.set({ [key]: fn(Object.assign({}, cur)) });
  }));
  const patchJob = p => patch('cardJobs', all => { if (all[orderId]) all[orderId] = Object.assign({}, all[orderId], p); return all; });
  const result = (no, r) => patch('cardResult', all => Object.assign(all, { [no]: Object.assign({ at: Date.now() }, r) }));
  let panel = null;
  const show = s => { if (!panel) panel = window.otPanel('按开票入口申请', [], () => {}, { top: true }); panel.set(s); };
  const closeLater = async ms => { await sleep(ms); window.otSend({ type: 'closeMe' }).catch(() => {}); };

  async function finish() {
    await patch('cardApplied', all => Object.assign(all, { [orderId]: Date.now() }));
    await patchJob({ state: 'done' });
    await result(orderId, { ok: true });
    show('已提交开票申请（订单 ' + orderId + '），结果已送回分拣主页。本页 3 秒后关闭。');
    closeLater(3000);
  }
  async function fail(why, keepOpen, state) {
    await patchJob({ state: state || 'failed', why });
    await result(orderId, { ok: false, why });
    show('未提交：' + why + '。原因已送回分拣主页' + (keepOpen ? '，请在本页核对。' : '，本页 10 秒后关闭。'));
    if (!keepOpen) closeLater(10000);
  }

  (async () => {
    const { cardJobs, cardRun } = await chrome.storage.local.get(['cardJobs', 'cardRun']);
    const job = cardJobs && cardJobs[orderId];
    if (!job || Date.now() > job.exp) {
      // 主页正在按卡片申请另一单，打开的却是这单：卡片归错了单，不提交
      if (!onDetail && cardRun && cardRun.clicked && !cardRun.error && cardRun.no !== orderId && Date.now() - cardRun.clicked < 60000) {
        const why = '申请页的订单号 ' + orderId + ' 与任务订单 ' + cardRun.no + ' 不符，未提交';
        show(why + '。本页 10 秒后关闭。');
        await result(cardRun.no, { ok: false, why });
        closeLater(10000);
      }
      return;
    }
    // 确认提交后跳到这里：确认成功
    if (onDetail) { if (job.state === 'confirming' || job.state === 'unconfirmed') await finish(); return; }
    if (job.state && job.state !== 'queued') return;                 // 已经有页面在处理（或处理过）这单
    // 认领：可能同时开出两个申请页（页面自己开了一个、被拦后后台又开了一个），只让一个页面提交
    const me = Math.random().toString(36).slice(2);
    await patchJob({ state: 'claiming', by: me });
    await sleep(400);
    const mine = ((await chrome.storage.local.get('cardJobs')).cardJobs || {})[orderId];
    if (!mine || mine.by !== me) return;
    await patchJob({ state: 'checking', opened: Date.now() });
    show('核对订单 ' + orderId + '：等待发票抬头加载…');
    await sleep(2000);                                               // 默认抬头约 2 秒后才加载出来（用户 2026-10-05）
    const page = () => squash(document.body.innerText);
    if (!job.title) return fail('设置中未填写发票抬头');
    if (!await window.otWaitFor(() => page().includes(squash(job.title)), 13000))
      return fail('页面上未出现设置中的发票抬头「' + job.title + '」（已等待 15 秒）');
    // 页面上写着税号时核对；只认「税号」后面紧跟的那串，别把订单号之类的长数字当成税号
    const tax = (/(?:税号|纳税人识别号|统一社会信用代码)[:：]?([0-9A-Za-z]{15,20})/.exec(page()) || [])[1];
    if (job.taxId && tax && tax.toUpperCase() !== String(job.taxId).toUpperCase()) return fail('页面上的税号 ' + tax + ' 与设置不符');
    await sleep(800);
    const submit = btn(/^提交申请$/);
    if (!submit) return fail('页面上未找到「提交申请」按钮');
    show('抬头' + (tax ? '、税号' : '') + '已核对，正在提交申请…');
    fullClick(submit);
    if (!await window.otWaitFor(() => btn(/^确认提交$/), 8000)) return fail('点击「提交申请」后未出现确认弹窗，未提交', true);
    await patchJob({ state: 'confirming' });
    fullClick(btn(/^确认提交$/));
    // 正常会整页跳到发票详情页，由那边的本脚本收尾；页面不跳、只显示成功字样时在这里收尾
    if (await window.otWaitFor(() => /提交成功|申请成功|已提交申请/.test(document.body.innerText), 15000)) return finish();
    // 跳走了（本页已不在）就不会走到这里；还在这一页、又没看到成功字样：留着页面给用户核对
    const { cardJobs: now } = await chrome.storage.local.get('cardJobs');
    if (((now || {})[orderId] || {}).state === 'confirming') fail('点击「确认提交」后未看到提交成功，请核对', true, 'unconfirmed');
  })().catch(e => { console.warn('[订单分拣] 按开票入口申请', e); show('出错：' + e.message); });
})();
