// 确认收货（用户 2026-10-09）：天猫订单交易成功后卖家须在 10 日内开票，插件先替用户确认收货，再在同一轮「自动处理发票」里申请平台开票。
// 只在主页排了这一单（recvRun：用户已在「自动处理发票」的确认清单里勾选确认）、且本页是这一单的页面（网址或页面文字里有订单号）时才动手：
//   订单详情页：按文字找「确认收货」按钮点一下 → 淘宝的确认页（或弹窗）：按文字找「确定」「确认」「确认收货」点一下 → 页面显示交易成功，写回 done。
// 页面上出现密码输入框、验证码、扫码时停下（state: manual）：插件绝不填写、读取或保存任何密码（只看密码框在不在），
// 把本页切到前台，等用户在这一页自己完成；之后页面显示交易成功（或跳到成功页）就写回 done。
// 找不到按钮、有好几个分不清该点哪个、确认页上没有本单订单号，都停下写明原因（state: fail），不猜着点别的按钮。
// 真实页面的「确认收货」按钮文字、确认页的地址和结构都还没核对过（待真实页面验证）；离线测试用 tools/mock-detail.html 的模拟页。
// recvRun = { id, no, at, state: open → clicked → submitted → done | manual | fail, why, t（上次改状态的时间）, clickedUrl }
(async () => {
  if (window.top !== window || window.__otRecv) return;
  window.__otRecv = 1;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = async () => (await chrome.storage.local.get('recvRun')).recvRun;
  const first = await get();
  if (!first || Date.now() - first.at > 10 * 60000 || ['done', 'fail'].includes(first.state)) return;
  const { no, id } = first;
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const mine = () => location.href.includes(no) || !!(document.body && document.body.innerText.includes(no));
  if (!await window.otWaitFor(mine, 20000)) return;                    // 不是这一单的页面：什么都不做
  const panel = window.otPanel('确认收货', [], () => {}, { top: true });
  const set = async patch => {
    const cur = await get();
    if (!cur || cur.id !== id) return false;
    await chrome.storage.local.set({ recvRun: Object.assign({}, cur, patch, { t: Date.now() }) });
    return true;
  };
  const fail = async why => { await set({ state: 'fail', why }); panel.set('未能确认收货：' + why + '。请在本页面自行处理。'); window.otLog('recv', 'fail', no + ' ' + why); };
  const DONE_RE = /交易成功|确认收货成功|已确认收货|收货成功/;
  // 要用户自己处理的：密码框（只看它在不在，不读不写不聚焦）、短信验证码、扫码、滑块 / 安全验证
  const pwdBox = () => [...document.querySelectorAll('input[type="password"]')].some(shown);
  const verify = () => window.otNeedsVerify() || [...document.querySelectorAll('input')].some(i => shown(i) && /验证码|校验码/.test(i.placeholder || ''))
    || /扫码(确认|验证|支付)|请使用.{0,10}扫一扫/.test(text(document.body).slice(0, 4000));
  const BTN = 'button, a, [role="button"], input[type="button"], input[type="submit"], [class*="btn"], [class*="Btn"], [class*="button"], [class*="Button"]';
  const label = el => el.tagName === 'INPUT' ? String(el.value || '').trim() : text(el);
  // 文字正好是这几个词之一的、看得见的按钮；嵌套的（按钮里套 span）只算最里面那个
  const find = (words, root) => {
    const els = [...(root || document).querySelectorAll(BTN)].filter(e => shown(e) && words.includes(label(e)));
    return els.filter(e => !els.some(o => o !== e && e.contains(o)));
  };
  const dialogs = () => [...document.querySelectorAll('[role="dialog"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(shown);
  const click = el => { for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, view: window })); };
  const OK_WORDS = ['确定', '确认', '确认收货', '确定收货'];
  const born = Date.now();
  for (;;) {
    const run = await get();
    if (!run || run.id !== id || ['done', 'fail'].includes(run.state) || Date.now() - run.at > 10 * 60000) return;   // 主页已结束、超时或换了下一单
    if (pwdBox() || verify()) {
      if (run.state !== 'manual') {
        await set({ state: 'manual', prev: run.state, why: pwdBox() ? '页面要求输入密码' : '页面出现验证' });
        panel.set('淘宝要求在本页面验证（插件不填写任何内容）。请自行完成确认收货，完成后插件自动继续。');
        window.otLog('recv', 'info', no + ' 等待用户在页面上完成验证');
        chrome.runtime.sendMessage({ type: 'focusMe' }).catch(() => {});
      }
      await sleep(1000); continue;
    }
    const body = text(document.body);
    // 点过确认（或交给用户处理过）以后，页面显示交易成功、也没有「确认收货」按钮了：完成
    if (['submitted', 'manual'].includes(run.state) && DONE_RE.test(body) && !find(['确认收货']).length) {
      await set({ state: 'done' });
      panel.set('已确认收货，交易成功。正在返回分拣主页继续申请开票…');
      window.otLog('recv', 'end', no + ' 已确认收货');
      window.otCloseLater(1500);
      return;
    }
    if (run.state === 'manual') { await sleep(1000); continue; }       // 用户在处理：插件什么都不点
    const since = Date.now() - Math.max(born, run.t || run.at);
    if (run.state === 'open') {
      const b = find(['确认收货']);
      if (!b.length) {
        if (since < 15000) { await sleep(800); continue; }
        // 已经确认过收货的单（用户自己点过）：页面上没有按钮、写着交易成功
        if (DONE_RE.test(body)) { await set({ state: 'done', already: true }); panel.set('本单已是交易成功。'); window.otCloseLater(1500); return; }
        return fail('页面上未找到「确认收货」按钮（淘宝页面可能已改版）');
      }
      if (b.length > 1) return fail('页面上有 ' + b.length + ' 个「确认收货」按钮，无法确定该点哪个');
      await set({ state: 'clicked', clickedUrl: location.href });
      panel.set('已点击「确认收货」，等待确认页…');
      click(b[0]);
      await sleep(1500); continue;
    }
    if (run.state === 'clicked') {
      // 还在原页面上：只认弹窗里的确认按钮（页面上原来那个「确认收货」不能再点）；跳到了新页面（确认页）：整页找
      const same = location.href === run.clickedUrl;
      const cands = [...new Set((same ? dialogs() : [document]).flatMap(r => find(OK_WORDS, r)))];
      if (!cands.length) {
        if (since < 20000) { await sleep(800); continue; }
        return fail('点击「确认收货」后 20 秒内未出现确认按钮（确认页可能已改版）');
      }
      if (cands.length > 1) return fail('确认页上有 ' + cands.length + ' 个确认按钮（' + cands.map(label).join('、') + '），无法确定该点哪个');
      if (!mine()) return fail('确认页上未找到本单订单号，未点击');
      await set({ state: 'submitted' });
      panel.set('已在确认页点击「' + label(cands[0]) + '」，等待交易成功…');
      click(cands[0]);
      await sleep(1500); continue;
    }
    if (run.state === 'submitted') {
      if (since > 30000) return fail('点击确认后 30 秒内页面未显示交易成功');
      await sleep(800); continue;
    }
    await sleep(800);
  }
})().catch(e => console.warn('[订单分拣] 确认收货', e));
