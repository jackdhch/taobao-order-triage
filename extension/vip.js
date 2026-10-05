// 淘宝官方客服（「已买到的宝贝」右边「官方客服」→ consumerservice.taobao.com/online-help → 跳到 ai.alimebot.taobao.com/intl/index.htm）：
// 卖家拿到开票信息很久（设置里的天数）还没开票，找淘宝官方人工客服督促（88VIP 会员和普通用户都适用）。用户 2026-10-05 示范：
//   先连发「人工」，机器人回「尊贵的88VIP会员，如有需要可点击下方按钮联系人工客服哦～」带「立即联系」按钮，点它；
//   转到人工后（中间出一条系统消息「官方客服xxxxx 人工客服」，客服打招呼「…我是您的88vip专属客服…」），才发督促的话——
//   提前发没用。发完就不管了（客服会自己跟进，要不要投诉之类的由用户看着回）。
// 页面结构（2026-10-05 实测）：消息 .Message.left / .Message.right / .Message.center，文字在 .Message-content；
// 输入框 textarea.Composer-input，发送按钮 button.Composer-sendBtn（按回车也能发）。
// 只在主页排了活（vipJob）时才动；页面上原来就有的聊天记录不算（只看开始之后新出现的消息）
(() => {
  if (window.top !== window || window.__otVip) return;
  window.__otVip = 1;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const text = el => ((el && el.innerText) || '').replace(/\s+/g, ' ').trim();
  const msgs = () => [...document.querySelectorAll('.Message')].filter(m => /\b(left|right|center)\b/.test(m.className));
  const box = () => document.querySelector('textarea.Composer-input');
  // 页面上的按钮只认完整的一次点击（按下→抬起→click），只调 click() 不理（2026-10-05 实测）
  const fullClick = b => { for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, view: window })); };
  async function say(s) {
    const t = box();
    if (!t) throw new Error('找不到输入框');
    t.focus();
    document.execCommand('selectAll'); document.execCommand('insertText', false, s);
    await sleep(400);
    const b = document.querySelector('button.Composer-sendBtn');
    if (!b) throw new Error('找不到发送按钮');
    fullClick(b);
    await sleep(800);
  }
  (async () => {
    const { vipJob: job } = await chrome.storage.local.get('vipJob');
    if (!job || Date.now() - job.at > 10 * 60000 || !(job.orders || []).length) return;
    follow.job = job;
    await chrome.storage.local.remove('vipJob');            // 领走：刷新页面也不会再来一遍
    const panel = window.otPanel('找客服督促开票', [], () => {}, { top: true });
    if (!await window.otWaitFor(() => box(), 30000)) { panel.set('客服页面未加载完成，未发送消息。'); return; }
    await sleep(2500);                                       // 等历史消息加载完
    const start = msgs().length;
    if (job.follow) return follow(0, start);
    const fresh = () => msgs().slice(start);
    // 转人工的标志：居中的系统消息「官方客服000000 人工客服」，或人工客服打招呼「…我是您的88vip专属客服，很高兴为您服务…」。
    // 机器人给的「联系人工」卡片里也会写「…专属客服 24小时在线服务」之类——带按钮的消息一律不算（2026-10-05 实测被它骗过一次，督促的话发给了机器人）
    const human = () => fresh().some(m => !m.querySelector('button') && (
      (/\bcenter\b/.test(m.className) && /官方客服\s*\d+\s*人工客服/.test(text(m))) ||
      // 只认普通客服、会员客服都会有的说法（不写死「88VIP」，用户 2026-10-05：不是每个人都有 88VIP）；机器人「小蜜」的话不算
      (/\bleft\b/.test(m.className) && !/小蜜/.test(text(m)) && /很高兴为您服务|人工客服.{0,6}为您服务|我是.{0,16}客服/.test(text(m)))));
    let asks = 0;
    for (let k = 0; k < 40 && !human(); k++) {
      if (window.otNeedsVerify()) { panel.set('页面出现安全验证，已暂停。完成验证后，请在分拣主页重新点击「找客服督促」。'); return; }
      // 机器人给了「立即联系」人工的按钮：点它（只点开始之后新出现的）
      const btn = fresh().flatMap(m => [...m.querySelectorAll('button')]).reverse().find(b => /立即联系|联系人工|转人工|人工客服/.test(text(b)) && !b.disabled && !b.dataset.otClicked);
      if (btn) { btn.dataset.otClicked = '1'; fullClick(btn); panel.set('已点击「' + text(btn) + '」，等待人工客服接入…'); await sleep(6000); continue; }
      if (asks < 8 && k % 3 === 0) { asks++; await say('人工'); panel.set('正在转人工客服：已发送「人工」' + asks + ' 次'); }
      await sleep(3000);
    }
    if (!human()) { panel.set('未能转到人工客服（已发送「人工」' + asks + ' 次），督促消息未发送。请稍后在分拣主页重新点击「找客服督促」。'); return; }
    panel.set('已转到人工客服，正在发送督促消息…');
    await sleep(3000);
    const urgeStart = msgs().length;
    const sendStart = urgeStart;
    const sent = {};
    for (const o of job.orders) {
      // 用户 2026-10-05 补充：发票抬头和税号也写进去
      await say('你好，订单号' + o.no + '隔了' + o.days + '天要求开发票到现在还没开出，发票抬头：' + job.title + '，税号：' + job.taxId + '，麻烦官方客服帮我督促开票');
      sent[o.no] = Date.now();
      panel.set('正在发送督促消息：' + Object.keys(sent).length + ' / ' + job.orders.length + ' 单');
      await sleep(4000);
    }
    const { vipSent } = await chrome.storage.local.get('vipSent');
    await chrome.storage.local.set({ vipSent: Object.assign({}, vipSent, sent) });
    panel.set('已发送 ' + job.orders.length + ' 单督促消息。正在等待客服处理…');
    return follow(urgeStart, sendStart);

  // 跟进：from 之后的消息里找按钮；okFrom 之后的新消息才回「OK」（页面上以前的聊天不重复回）
  async function follow(urgeStart, okFrom) {
    const job = follow.job;

    // 发完以后客服会接着走流程（2026-10-05 用户示范）：
    //   问「…小二马上帮您发起投诉商家拒绝开票处理呢，您看可以吗？」→ 回「OK」；
    //   发「请核实并提交投诉信息」卡片，带「提交投诉」按钮 → 点它（之后卡片变成「已提交 查看」）；
    //   发「申请发票卡片 …填写开票申请」卡片（平台批量开票没有入口时，客服可以给开）→ 点「填写开票申请」，后面的确认还没示范，先提示用户。
    // 全部按页面上的文字和按钮写死；最多盯 30 分钟，10 分钟没有新消息就停
    const done = new Set(), notes = [], okDone = new Set();
    const head = job.follow ? '跟进中（督促消息之前已发过）。' : '已发送 ' + job.orders.length + ' 单督促消息。';
    const note = s => { notes.push(s); panel.set(head + notes.join('；') + '。正在等待客服处理…'); };
    const t1 = Date.now();
    let seen = msgs().length, lastNew = Date.now(), formNote = false;
    while (Date.now() - t1 < 30 * 60000 && Date.now() - lastNew < 10 * 60000) {
      await sleep(2000);
      const all = msgs();
      if (all.length !== seen) { seen = all.length; lastNew = Date.now(); }
      for (const m of all.slice(urgeStart)) {
        if (done.has(m) || !/\bleft\b/.test(m.className)) continue;
        const tx = text(m);
        const btns = [...m.querySelectorAll('button')].filter(x => !x.disabled);
        const sub = btns.find(x => /^提交投诉$/.test(text(x)));
        if (sub) { done.add(m); fullClick(sub); note('已点「提交投诉」'); await sleep(2500); continue; }
        const form = btns.find(x => /填写开票申请/.test(text(x)));
        if (form) {
          done.add(m); fullClick(form); formNote = true;
          note('客服给了开票申请入口，已点「填写开票申请」，请在弹出的页面里确认提交');
          await sleep(2500); continue;
        }
        // 客服说要帮着投诉商家：「…订单5190000000000000301…小二马上帮您发起投诉商家拒绝开票处理呢，您看可以吗？」
        // 或「…5190000000000000302订单…小二马上帮您发起投诉商家拒绝开票处理，投诉发起后可以先交给我们…」（2026-10-05 两种说法都见过）。
        // 要写着这次督促的某个订单号；「已帮您发起投诉」是事后说明，不回；每单只回一次「OK」
        const ono = (tx.match(/\d{19}/g) || []).find(n => job.orders.some(o => o.no === n));
        if (!btns.length && ono && !okDone.has(ono) && all.indexOf(m) >= okFrom && /帮您发起投诉/.test(tx) && !/已(经)?帮您发起投诉|投诉已发起/.test(tx)) {
          done.add(m); okDone.add(ono); await say('OK'); note('订单 ' + ono + '：客服提出投诉商家，已回复「OK」'); continue;
        }
      }
    }
    panel.set(head + (notes.length ? notes.join('；') + '。' : '') + (formNote ? '开票申请请在弹出的页面里确认。' : '') + '已停止自动处理，后续回复请在本页查看。');
  }
  })().catch(e => console.warn('[订单分拣] 找客服督促', e));
})();
