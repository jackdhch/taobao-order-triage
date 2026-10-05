// 淘宝「我的发票 → 批量开票」页（i.taobao.com/my_itaobao/pricelist/batchInvoice）
//
// 一键平台申请：主页把要申请的订单排进 applyJob = { nos, from, to, title, taxId, at }，打开本页。本页：
//   1. 日期范围设成 from ~ to（只能按下单日期筛，不能按订单号；改筛选会清空已勾的，所以只设一次）
//   2. 逐页翻，只勾 applyJob 里的单（翻页时已勾的会保留）；列表里没有的单记下来：平台不能开，要找卖家
//   3. 点「提交申请」，在「批量开票申请」里核对抬头、税号，确认「企业」「明细」已选，弹窗里只有要申请的单
//   4. 点「下一步」，停在「批量开票确认」，由用户自己核对后点「确认提交」。插件不点「确认提交」
//
// 页面结构（2026-10 用户在真实页面上示范）：
//   订单分组头 [class*="group-header-orderId"]（订单号在 [class*="group-header-title-number"]），同一组里一个 input.next-checkbox-input；
//   日期是 Fusion 的范围选择器：两个只读输入框，点开后面板上方 .next-range-picker-panel-input-start-date / -end-date 里的输入框可以写，
//   日历格子 td.next-calendar-cell[title="YYYY-MM-DD"]，底部「确定」。写起点要发 keyCode=13 的回车；终点要先点终点框再点格子；
//   翻页按钮在 [class*="pagination"] 里；「清空选择」会再弹一个确认框；
//   提交后的两层弹窗都是同一个 .next-dialog-v2：「批量开票申请」（底部「下一步」）→「批量开票确认」（「上一步」「确认提交」）。
//   弹窗里还藏着一套看不见的「个人或事业单位」表单，只能认看得见的那套。
(() => {
  if (window.__otBatch) return;
  window.__otBatch = 1;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const q = s => document.querySelector(s);
  const heads = () => [...document.querySelectorAll('[class*="group-header-orderId"]')].filter(vis);
  const noOf = h => text(h.querySelector('[class*="group-header-title-number"]') || h).replace(/\D/g, '');
  const pageNos = () => heads().map(noOf);
  const boxOf = h => { let g = h; while (g && !g.querySelector('input.next-checkbox-input')) g = g.parentElement; return g && g.querySelector('input.next-checkbox-input'); };
  const selectedN = () => +((document.body.innerText.match(/已选\s*(\d+)\s*个订单/) || [, 0])[1]);
  const button = (re, root) => [...(root || document).querySelectorAll('button')].filter(vis).find(b => re.test(text(b)));
  const dialog = re => [...document.querySelectorAll('.next-dialog')].filter(vis).find(d => re.test(text(d.querySelector('.next-dialog-header') || d)));

  // 回车要在页面自己的环境里发（extension/batch-main.js）：这里补的 keyCode 页面看不见
  function enter(el) {
    el.setAttribute('data-ot-enter', '1');
    window.dispatchEvent(new CustomEvent('ot-enter'));
  }
  function setValue(el, v) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);   // 绕过 React 自己记的旧值
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 日期范围：起点写进面板输入框 + 回车；终点先点终点框，再点那天的格子（不在当前月份就翻月）；最后「确定」
  async function setRange(from, to) {
    const trig = q('input[placeholder="起始日期"]');
    if (!trig) throw new Error('页面上未找到日期筛选框');
    trig.click(); await sleep(600);
    const a = q('.next-range-picker-panel-input-start-date input');
    if (!a) throw new Error('日期面板未打开');
    a.focus(); setValue(a, from); enter(a); await sleep(500);
    const e = q('.next-range-picker-panel-input-end-date input');
    e.focus(); e.click(); await sleep(300);
    for (let k = 0; k < 24; k++) {
      const c = [...document.querySelectorAll('td.next-calendar-cell[title="' + to + '"]')].find(vis);
      if (c) { (c.querySelector('div') || c).click(); break; }
      const nav = q(to > from ? '.next-calendar-btn-next-month' : '.next-calendar-btn-prev-month');
      if (!nav) throw new Error('日历上未找到 ' + to);
      nav.click(); await sleep(300);
    }
    await sleep(300);
    const ok = [...document.querySelectorAll('.next-date-picker-panel-footer button')].find(x => /确定/.test(text(x)));
    if (ok && !ok.disabled) ok.click();
    await sleep(500);
    const got = [...document.querySelectorAll('input[placeholder="起始日期"], input[placeholder="结束日期"]')].map(i => i.value);
    if (got[0] !== from || got[1] !== to) throw new Error('日期未设置成功（当前为 ' + got.join(' ~ ') + '）');
  }
  // 等列表刷新：订单号串变了，或出现「暂无」
  async function waitList(before) {
    await window.otWaitFor(() => pageNos().join(',') !== before || /暂无未申请订单/.test(document.body.innerText), 12000);
    await sleep(600);
  }
  const nextBtn = () => [...document.querySelectorAll('[class*="pagination"] button')].find(b => /下一页/.test(text(b)));
  const nextOff = b => !b || b.disabled || /disabled/.test(b.className);

  async function apply(job) {
    if (!panel) panel = window.otPanel('平台批量开票', [], () => {});
    const want = new Set(job.nos.map(String));
    const found = [], money = {};
    panel.set('正在筛选 ' + job.from + ' 至 ' + job.to + ' 的订单…');
    if (!await window.otWaitFor(() => q('input[placeholder="起始日期"]'), 20000)) throw new Error('页面未加载完成');
    if (selectedN()) {                                   // 页面上本来就勾着的（别处留下的）先清掉，免得一起提交
      button(/清空选择/).click(); await sleep(500);
      const yes = button(/^清空$/); if (yes) { yes.click(); await sleep(600); }
    }
    const before = pageNos().join(',');
    await setRange(job.from, job.to);
    await waitList(before);
    for (let page = 1; page <= 200; page++) {
      if (window.otNeedsVerify()) throw new Error('页面出现安全验证，请手动完成后在分拣主页重新操作');
      // 每勾一单页面可能重画整个列表，之前拿到的元素就不在页面上了：每次都按订单号重新找
      const findHead = no => heads().find(h => noOf(h) === no);
      for (const no of pageNos()) {
        if (!want.has(no) || found.includes(no)) continue;
        let box = boxOf(findHead(no) || document.body);
        if (!box || box.disabled) continue;
        if (!box.checked) { box.click(); await sleep(300); box = boxOf(findHead(no) || document.body); }
        if (box && box.checked) {
          found.push(no);
          let g = findHead(no); while (g && !/¥/.test(text(g))) g = g.parentElement;
          const m = /¥\s*([\d,]+\.\d{2})/.exec(text(g)); if (m) money[no] = +m[1].replace(/,/g, '');
        }
      }
      panel.set('第 ' + page + ' 页：已勾选 ' + found.length + ' / ' + want.size + ' 单');
      if (found.length === want.size) break;
      const nb = nextBtn();
      if (nextOff(nb)) break;
      const key = pageNos().join(',');
      nb.click();
      await waitList(key);
    }
    const missing = job.nos.filter(n => !found.includes(String(n)));
    await chrome.storage.local.set({ applyJob: Object.assign({}, job, { stage: 'picked', found, missing }) });
    if (!found.length) { panel.set('列表中没有这些订单：无法在淘宝平台开票，分拣主页将改为「需向卖家索要发票」。本页 5 秒后关闭。'); return done(job, found, missing); }
    if (selectedN() !== found.length) throw new Error('页面「已选」为 ' + selectedN() + ' 单，与插件勾选的 ' + found.length + ' 单不符，已停止');

    // 「批量开票申请」：核对抬头税号，确认企业 + 明细
    button(/^提交申请$/).click();
    if (!await window.otWaitFor(() => dialog(/批量开票申请/), 10000)) throw new Error('未弹出「批量开票申请」');
    await sleep(600);
    const d = dialog(/批量开票申请/);
    const field = id => [...d.querySelectorAll('input#' + id)].find(vis);
    const title = field('payerName'), tax = field('payerRegisterNo');
    if (!title || !tax) throw new Error('弹窗中未找到抬头 / 税号');
    if (job.title && title.value.trim() !== job.title) throw new Error('抬头为「' + title.value + '」，与设置中的「' + job.title + '」不一致，已停止，请核对');
    if (job.taxId && tax.value.trim().toUpperCase() !== job.taxId) throw new Error('税号为「' + tax.value + '」，与设置不一致，已停止，请核对');
    for (const label of ['企业', '明细']) {
      const w = [...d.querySelectorAll('.next-radio-wrapper')].filter(vis).find(x => text(x) === label);
      if (!w) throw new Error('弹窗中未找到「' + label + '」');
      if (!w.querySelector('input').checked) { (w.querySelector('input') || w).click(); await sleep(300); }
      if (!w.querySelector('input').checked) throw new Error('「' + label + '」未能选中，已停止');
    }
    const listed = (text(d).match(/\d{19}/g) || []);
    const extra = listed.filter(n => !found.includes(n));
    if (extra.length) throw new Error('弹窗中出现插件未勾选的订单 ' + extra.join('、') + '，已停止');
    button(/^下一步$/, d).click();
    if (!await window.otWaitFor(() => dialog(/批量开票确认/), 10000)) throw new Error('未出现「批量开票确认」');
    const sum = found.reduce((s, n) => s + (money[n] || 0), 0);
    const token = Math.random().toString(36).slice(2);
    try { sessionStorage.setItem('otApplyToken', token); } catch (e) { /* 读不到就只靠同一页面实例里的判断 */ }
    myToken = token;
    await chrome.storage.local.set({ applyJob: Object.assign({}, job, { stage: 'confirm', found, missing, at: Date.now(), token }) });
    panel.set('已勾选 ' + found.length + ' 单（合计 ¥' + sum.toFixed(2) + '），抬头、税号、明细均已核对。'
      + '请在「批量开票确认」中核对后，手动点击「确认提交」。' + (missing.length ? '另有 ' + missing.length + ' 单不在列表中（无法在平台开票）。' : ''));
    await chrome.storage.local.set({ applyResult: { at: Date.now(), found, missing, stage: 'confirm' } });
  }
  function done(job, found, missing) {
    window.otCloseLater(5000);                                        // 插件开的干活页：没有可申请的单，关掉
    return chrome.storage.local.set({ applyJob: null, applyResult: { at: Date.now(), found, missing, stage: 'none' } });
  }

  // 「我的淘宝」是单页应用：从左侧菜单点进批量开票时页面不重新加载，所以本脚本在 my_itaobao 下都注入，看地址决定干不干活
  const onBatch = () => /\/pricelist\/batchInvoice/.test(location.pathname);
  let panel = null;
  const one = window.otQueue();
  const run = () => one('apply', async () => {
    if (!onBatch() || document.visibilityState !== 'visible') return;
    const { applyJob: job } = await chrome.storage.local.get('applyJob');
    if (!job || job.stage || Date.now() - job.at > 600000) return;     // 只领 10 分钟内、还没开始的活
    if (!panel) { panel = window.otPanel('平台批量开票', [], () => {}); }
    await chrome.storage.local.set({ applyJob: Object.assign({}, job, { stage: 'running' }) });
    try { await apply(job); }
    catch (e) {
      panel.set('已停止：' + e.message + '。原因已送回分拣主页，本页 10 秒后关闭。');
      await chrome.storage.local.set({ applyJob: null, applyResult: { at: Date.now(), error: e.message } });
      // 安全验证要用户在本页完成，不关
      if (!window.otNeedsVerify()) window.otCloseLater(10000);
    }
  });
  // 停在「批量开票确认」以后，用户点了「确认提交」淘宝会跳去「申请中发票」：告诉主页去同步一次。
  // 用户点「上一步」、关掉弹窗、离开页面也会走到这里——没关系，同步出来的才是真实状态
  // 只有做这次申请的那个标签页才判断：同时开着的「全部发票」等页面里也注入了本脚本，它们不在批量开票页，
  // 之前会误以为「已经离开确认页 = 提交了」（2026-10-03 真实窗口里出现过）
  let myToken = '';
  async function maybeSubmitted() {
    const { applyJob: job } = await chrome.storage.local.get('applyJob');
    if (!job || job.stage !== 'confirm' || !job.token) return;
    let tabToken = myToken;
    try { tabToken = tabToken || sessionStorage.getItem('otApplyToken') || ''; } catch (e) { /* 同上 */ }
    if (tabToken !== job.token) return;
    if (onBatch() && (dialog(/批量开票确认/) || dialog(/批量开票申请/))) return;   // 还在弹窗里（含点了「上一步」）
    try { sessionStorage.removeItem('otApplyToken'); } catch (e) { /* 同上 */ }
    // 先标记「要关了」：淘宝提交后跳到「全部发票」页，本页也注入了同步脚本，别让它领走主页接着排的同步活
    window.__otClosing = true;
    await chrome.storage.local.set({ applyJob: null, applyResult: { at: Date.now(), found: job.found, missing: job.missing, stage: 'submitted' } });
    window.otCloseLater(1500);                                        // 插件开的干活页：提交完就关（主页会另开页同步）
  }
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) { last = location.href; run(); }
    maybeSubmitted();
  }, 1000);
  if (onBatch()) {
    if (!panel) { panel = window.otPanel('平台批量开票', [], () => {}); panel.set('等待分拣主页分配任务：平台批量开票'); }
    run();
  }
  document.addEventListener('visibilitychange', () => run());
  chrome.storage.onChanged.addListener(ch => { if (ch.applyJob && ch.applyJob.newValue && !ch.applyJob.newValue.stage) run(); });
})();
