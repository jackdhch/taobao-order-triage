// 淘宝旺旺网页版（market.m.taobao.com/app/im/chat，聊天内容在 iframe chat-core 里；本脚本在每个框架里都注入，
// 只在有会话列表的那个框架里干活）
//
// 扫描：只看主页给的「还需要卖家回复」的那几家店（invWant.chat）。逐个点开会话，往上滚加载聊天记录到那几单最早的日期，
//       记下我们要发票的消息、之后对方发来的文件 / 图片（可能是二维码）/ 提到邮箱的话，存进扩展存储 chatScan。
//       只点左侧会话、只滚动消息列表；不碰输入框和「发送」。打开会话会让对方看到「已读」，所以范围只限这几家。
// 下载：主页里点了「下载」的聊天文件排在 dlJobs 里，这里打开会话找到那个文件点「下载文件」。
// 发消息：主页排的 chatQueue(kind=compose)：逐家打开会话，把写好的消息填进输入框（.editBox pre.edit[contenteditable=true]），
//       「自动处理发票」清单确认过的（auto）核对会话后代点「发送」；发票表里逐单的「索要发票」「催卖家」（follow）只填不发，由用户点发送；
//       看到这条消息出现在聊天里，记进 askSent，自动开下一家。
// 开票卡片：卖家发来的「请填写发票申请 … 去申请」模板卡片单独记成 card（不算图片）；主页排了 cardRun 时，打开会话找到卡片点「去申请」。
//
// 页面结构（2026-09 实测）：会话 .conversation-item > .name（长店名会截断成「…」）；消息 .message-item(.self) > .nick .time .content；
// 文字在 pre.edit，文件 .file-msg > .file-name[title=完整文件名] .file-size a.download-file；
// 右侧「我的订单」.ww_tab .order-id 是和这家店的订单号；消息列表 .ww_message .rc-scrollbars-view 滚到顶加载更早的
(() => {
  if (window.__otChat) return;
  window.__otChat = 1;
  // 只留一个旺旺页（见 background.js）：外层页面打开就报到；聊天框架里出现「连接断开」超过 5 秒就告诉后台（刷新或关掉）
  if (window.top === window) chrome.runtime.sendMessage({ type: 'chatHello' }).catch(() => {});
  else {
    let dc = 0;
    const tick = setInterval(() => {
      const t = [...document.querySelectorAll('.next-message-title')].some(e => e.offsetWidth && /连接断开/.test(e.textContent));
      dc = t ? dc + 1 : 0;
      if (dc >= 2) { clearInterval(tick); chrome.runtime.sendMessage({ type: 'chatDisconnected' }).catch(() => {}); }
    }, 3000);
  }
  // 聊天界面是异步渲染的，外层页面里也会注入本脚本：等 30 秒还没有会话列表，就不是聊天那个框架。
  // 聊天框架（或没有聊天框架的外层页面）30 秒还没出会话列表、主页又正等着这个旺旺页干活：报给主页（以前什么都不出，主页干等到超时）
  window.otWaitFor(() => document.querySelector('.ww_conversation_list, .ww_conversation'), 30000).then(async ok => {
    if (ok) return boot();
    if (!/\/chat-core\//.test(location.pathname) && !(window.top === window && !document.querySelector('iframe'))) return;
    const { invJobs, chatQueue, cardRun } = await chrome.storage.local.get(['invJobs', 'chatQueue', 'cardRun']);
    const fresh = t => !!t && Date.now() - t < 5 * 60000;
    if (fresh((invJobs || {}).scan) || fresh((invJobs || {}).chatDownload) || (chatQueue && fresh(chatQueue.at)) || (cardRun && fresh(cardRun.at)))
      window.otFail('chat', '旺旺页 30 秒内未显示会话列表（可能未登录淘宝、网络慢或页面已改版）');
  });

  function boot() {
    const I = window.Invoice;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    const squash = s => String(s || '').replace(/\s+/g, '');
    // 会话列表里的长店名会被截断成「某某旗舰…」；只有截断的才按前缀对，否则要完全一样（别把「某某」对到「某某二店」）
    const sameShop = (full, shown) => {
      full = squash(full); shown = squash(shown);
      if (!full || !shown) return false;
      if (/[…]$|\.\.\.$/.test(shown)) return full.startsWith(shown.replace(/[…]$|\.\.\.$/, ''));
      return full === shown;
    };
    const view = () => document.querySelector('.ww_message .rc-scrollbars-view');
    const header = () => text(document.querySelector('.ww_header .name'));
    const convItems = () => [...document.querySelectorAll('.conversation-item')];
    const convName = it => text(it.querySelector('.name'));
    // 这一单要找的会话：会话名可能是店名，也可能是卖家旺旺名（个人卖家多是这样，2026-10 实测：有家店的会话名是卖家本人的名字）
    const isConvOf = (o, name) => sameShop(o.shop, name) || (!!o.nick && sameShop(o.nick, name));

    // 模板卡片（div.im-template-msg.dx-msg-wrap > div.tpl-wrapper[data-tpl-id]，2026-10-05 实测）：商品推荐、开票申请等。
    // 卡片里的背景图、透明图都不是卖家发来的图片（开票申请卡片曾被当成「可能是二维码」）。
    // 开票申请卡片的文字依次是「请填写发票申请」「商品标题」「¥ 139 .00」「共1件商品」「如您有发票需求…」「去申请」，没有订单号
    const CARD_TPL = '4278793723922.PNM';
    const TPL_SEL = '.im-template-msg, .dx-msg-wrap, [data-tpl-id]';
    const tplOf = m => m.querySelector('.content .im-template-msg, .content .dx-msg-wrap, .content [data-tpl-id]');
    // 「去申请」按钮：文字正好是「去申请」的最里层元素（真实页面是 div.dx-event-node）
    const goBtn = root => root && [...root.querySelectorAll('*')].find(e => text(e) === '去申请' && ![...e.children].some(c => text(c) === '去申请'));
    function cardOf(tpl) {
      if (!tpl) return null;
      const lines = (tpl.innerText || '').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const at = lines.findIndex(s => /发票申请/.test(s));
      const tplId = (tpl.matches('[data-tpl-id]') ? tpl : tpl.querySelector('[data-tpl-id]') || tpl).getAttribute('data-tpl-id') || '';
      if (!goBtn(tpl) || (at < 0 && tplId !== CARD_TPL)) return null;
      const title = lines.slice(at + 1).find(s => !/^[¥￥]/.test(s) && !/共\s*\d+\s*件|去申请|发票需求|发票申请/.test(s)) || '';
      const pl = (lines.find(s => /^[¥￥]/.test(s)) || '').replace(/[^\d.]/g, '');
      return { title, price: pl && !isNaN(+pl) ? (+pl).toFixed(2) : '' };
    }
    // 一条消息读不了（比如「安全提醒：检测到外部链接」这类系统卡片结构特殊）就跳过这一条，别让整个会话、整轮扫描停下
    function readMsgs() {
      return [...document.querySelectorAll('.message-item')].map(m => { try { return readMsg(m); } catch (e) { return null; } }).filter(m => m && m.time);
    }
    function readMsg(m) {
      const fileEl = m.querySelector('.file-msg');
      // 商品卡片（.item-pic 之类）、模板卡片里的图不算；只在消息内容里面找，别找到外层 .message-item-line 上去
      const img = [...m.querySelectorAll('.content img')].find(i => i.getBoundingClientRect().width > 60 && !i.closest('.content [class*="item-"]') && !i.closest(TPL_SEL));
      return {
        self: m.classList.contains('self'),
        time: text(m.querySelector('.time')),
        text: text(m.querySelector('.content pre.edit')) || '',
        file: fileEl ? { name: (fileEl.querySelector('.file-name') || {}).title || text(fileEl.querySelector('.file-name')), size: text(fileEl.querySelector('.file-size')) } : null,
        img: img ? img.currentSrc || img.src : '',
        card: cardOf(tplOf(m)),
      };
    }
    // 攒消息：同一条（时间 + 谁发的 + 第几条）只留读到内容的那次
    let pile = new Map();
    function snap() {
      const ms = readMsgs(), n = {};
      for (const m of ms) {
        const k0 = m.time + '|' + (m.self ? 1 : 0);
        n[k0] = (n[k0] || 0) + 1;
        const k = k0 + '|' + n[k0];
        const old = pile.get(k);
        if (!old || (!old.text && m.text) || (!old.file && m.file) || (!old.img && m.img) || (!old.card && m.card)) pile.set(k, m);
      }
    }
    const collected = () => { snap(); return [...pile.values()].sort((a, b) => a.time.localeCompare(b.time)); };
    // 往上滚到 since 之前（或连续 3 次再也加载不出更早的）
    async function loadBack(since) {
      pile = new Map(); snap();
      for (let k = 0, still = 0; k < 40 && still < 3; k++) {
        if (window.otNeedsVerify()) return false;
        const v = view(); if (!v) return true;
        const first = (readMsgs()[0] || {}).time || '';
        if (since && first && first < since) return true;
        const n = document.querySelectorAll('.message-item').length;
        v.scrollTop = 0; v.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(1500);
        snap();
        still = document.querySelectorAll('.message-item').length === n ? still + 1 : 0;
      }
      return true;
    }
    // 按名字现找条目再点：打开一个会话、滚动加载历史后，旺旺会重画左侧列表，之前拿到的条目已经不在页面上了，点了没反应（2026-09 实测）
    async function openConv(item) {
      const name = convName(item);
      item = convItems().find(x => convName(x) === name) || item;
      if (!sameShop(header(), name)) {
        // 点最里面的店名：旺旺响应点击的是条目里面的元素，点外框没反应（2026-09 实测）；点里面的事件会一路冒泡到外框
        (item.querySelector('.name') || item).click();
        await window.otWaitFor(() => sameShop(header(), name), 8000);
        await sleep(1500);
      }
      return sameShop(header(), name);
    }

    // 打开和某个卖家的聊天：和订单页旺旺图标打开的地址一样（uid=cntaobao<旺旺名>）。聊天在 iframe 里，要让外层页面跳
    function goChat(nick) {
      const url = 'https://market.m.taobao.com/app/im/chat/index.html?&uid=' + encodeURIComponent('cntaobao' + nick) + '&gid=&type=web';
      try { window.top.location.href = url; } catch (e) { location.href = url; }
    }
    const uidHere = () => { const m = /[?&]uid=([^&#]+)/.exec(location.href); try { return m ? decodeURIComponent(m[1]).replace(/^cntaobao/, '') : ''; } catch (e) { return ''; } };
    // 读出来的消息靠不住（旺旺页改版、选择器失效）：页面上有消息却一条没读出来、标题是空的、上次读到过内容这次却是空的。
    // 这时不覆盖这家店上次的结果（不然已要过票、卖家已回过的店全部退回「需向卖家索要」），记成读取失败
    const unreliable = (msgs, prev) => !header() || (!msgs.length && (document.querySelectorAll('.message-item').length > 0
      || !!(prev && (prev.first || (prev.asks || []).length || (prev.files || []).length))));
    const MAYBE_CHANGED = '消息未能读取（旺旺页可能改版）';
    // 扫描结束：写 chatScan（convs 读到的会话；failed 没读成的 [{ name, nick, nos, why }]，主页把这几单标成「旺旺会话未能读取」，
    // 不退回「需向卖家索要」；read 这一轮读成的个数）。一个都没读成就报错
    async function finishScan(out, failed, read) {
      await chrome.storage.local.set({ chatScan: { at: Date.now(), convs: out, failed, read } });
      const fl = failed.length ? '；未能读取 ' + failed.length + ' 个：' + failed.map(f => f.name + '（' + f.why + '）').join('、') : '';
      if (!read && failed.length) window.otFail('scan', '旺旺页一个会话都没能读取' + fl);
      else window.otLog('scan', 'end', '读取 ' + read + ' 个会话' + fl);
      panel.set('已读取 ' + read + ' 个会话，结果已送回分拣主页' + fl);
    }
    // 页面因为 goChat 重新加载后：看当前这个会话，记结果，跳下一家；最后一家看完写 chatScan
    async function resumeQueue() {
      const { chatQueue: q, askBeat } = await chrome.storage.local.get(['chatQueue', 'askBeat']);
      if (!q || Date.now() - q.at > (q.kind === 'compose' ? 60 : 20) * 60000 || !q.items || !q.items.length) return false;
      const cur = q.items[0];
      if (squash(uidHere()) !== squash(cur.nick)) return false;          // 不是插件打开的（用户自己在用旺旺）
      // 自动发送只在主页那一轮还在等它的时候做（主页每两秒写一次 askBeat，编号要对得上）：主页关了、刷新了、超时停了，
      // 留下的队列不能在用户之后自己打开这家的会话时接着自动发
      if (q.kind === 'compose' && q.auto && !(askBeat && askBeat.id === q.id && Date.now() - askBeat.t < 20000)) {
        await chrome.storage.local.remove('chatQueue');
        panel.set('分拣主页已不在等待发送（任务已停止），未自动发送。');
        window.otLog('ask', 'skip', '队列已过期，未接管：' + cur.shop);
        return false;
      }
      if (q.kind === 'dl') return resumeDownload(q, cur);
      if (q.kind === 'compose') return resumeCompose(q, cur);
      const verify = async () => { window.otFail('scan', '旺旺页出现安全验证，请在该页面手动完成后，在分拣主页重新点「自动处理发票」'); await chrome.storage.local.remove('chatQueue'); return true; };
      if (window.otNeedsVerify()) return verify();
      const n0 = q.done + 1, total = q.done + q.items.length;
      panel.set('正在读取第 ' + n0 + ' / ' + total + ' 个会话：' + cur.shop + '（' + cur.nick + '）');
      // 会话标题可能是旺旺名，也可能是店名；按地址打开的页面加载慢，和发消息一样等 30 秒
      const isTarget = () => sameShop(cur.nick, header()) || sameShop(cur.shop, header());
      const opened = await window.otWaitFor(isTarget, 30000);
      const next = Object.assign({}, q, { items: q.items.slice(1), done: q.done + 1, at: Date.now(), failed: (q.failed || []).slice(), read: q.read || 0 });
      const fail = why => next.failed.push({ name: cur.shop, nick: cur.nick, nos: cur.nos, why });
      if (opened) {
        await sleep(1200);
        if (!await loadBack(q.since)) return verify();
        const msgs = collected();
        const orders = [...document.querySelectorAll('.ww_tab .order-id')].map(text).filter(x => /^\d{15,20}$/.test(x));
        // 保险：右侧「我的订单」里要有这一单，才算是这一单的卖家；没有就记下来，不去猜
        const matched = cur.nos.some(no => orders.includes(no));
        if (unreliable(msgs, (q.out || {})[header()])) fail(MAYBE_CHANGED);
        else {
          next.out = Object.assign({}, q.out, { [header()]: Object.assign({ at: Date.now(), orders, first: (msgs[0] || {}).time || '', byNick: cur.nick, matched },
            I.chatAnalyze(msgs, { taxId: q.taxId })) });
          next.read++;
        }
      } else fail('会话未打开，页面显示「' + (header() || '空') + '」');
      if (next.items.length) {
        await chrome.storage.local.set({ chatQueue: next });
        await sleep(800 + Math.random() * 800);
        goChat(next.items[0].nick);
        return true;
      }
      await chrome.storage.local.remove('chatQueue');
      await finishScan(next.out || {}, next.failed, next.read);
      return true;
    }

    // 输入框：聊天记录里每条消息也是 pre.edit，只有输入框是可编辑的（2026-10-03 实测）
    const inputBox = () => document.querySelector('.editBox pre.edit[contenteditable="true"]') || document.querySelector('pre.edit[contenteditable="true"]');
    const sentCount = msg => readMsgs().filter(m => m.self && squash(m.text).includes(squash(msg).slice(0, 30))).length;
    // 输入框里还是插件填的那条消息，就清掉（用户自己改过、写了别的，不动）
    function clearMine(msg) {
      const b = inputBox();
      if (b && squash(b.innerText).includes(squash(msg).slice(0, 30))) { b.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
    }
    async function resumeCompose(q, cur) {
      const n0 = q.done + 1, total = q.done + q.items.length;
      const next = Object.assign({}, q, { items: q.items.slice(1), done: q.done + 1, waiting: null });
      // 等用户处理的上限：自动发送（主页那一轮在等）3 分钟，超时按跳过；逐单「索要发票」「催卖家」是用户自己点的，等 30 分钟
      const waitMax = q.waitMs || (q.auto ? 3 * 60000 : 30 * 60000);
      // 队列还是不是这一轮的（主页超时停掉会删掉它；编号不对就是别的一轮）
      const mine = async () => { const { chatQueue: still } = await chrome.storage.local.get('chatQueue'); return !!still && still.id === q.id; };
      const go = async () => {
        next.at = Date.now();
        // 主页那边超时停掉了队列（chatQueue 被删或换了一轮）：不再接着开下一家
        if (!await mine()) { panel.buttons([]); panel.set('分拣主页已停止发送：发送 ' + next.sent.length + ' 家，其余未发送。'); return; }
        if (next.items.length) { await chrome.storage.local.set({ chatQueue: next }); await sleep(800); goChat(next.items[0].nick); return; }
        await chrome.storage.local.remove('chatQueue');
        panel.buttons([]); panel.detail([]);
        panel.set('已处理完毕：发送 ' + next.sent.length + ' 家' + (next.skipped.length ? '，跳过 ' + next.skipped.length + ' 家（' + next.skipped.join('、') + '）' : '') + '。卖家回复后，「自动处理发票」会读取并下载。');
      };
      // 要用户处理时：告诉主页在等什么（主页进度里一句话），把旺旺页切到前台；最多等 waitMax，用户点「跳过此店」、发了、或会话切走就结束
      // done()：等到的条件。返回 'skip' | 'done' | 'left' | 'timeout'
      async function waitUser(why, done) {
        if (await mine()) await chrome.storage.local.set({ chatQueue: Object.assign({}, q, { waiting: { shop: cur.shop, why, at: Date.now() } }) });
        chrome.runtime.sendMessage({ type: 'focusMe' }).catch(() => {});
        let skip = false;
        panel.buttons([['skip', '跳过此店', '不给这家店发送，继续下一家']]);
        onPanel = id => { if (id === 'skip') skip = true; };
        const t0 = Date.now();
        let r = 'timeout';
        while (Date.now() - t0 < waitMax) {
          await sleep(500);
          if (skip) { r = 'skip'; break; }
          if (done && done()) { r = 'done'; break; }
          // 会话切走了（用户点了别的会话，或页面自己跳了）：输入框里的字会跟着带到别的会话，马上清掉、停下
          if (done && !isTarget()) { r = 'left'; break; }
        }
        onPanel = null;
        return r;
      }
      panel.detail(cur.orders);
      // 会话名可能是旺旺名，也可能是店名；按地址打开的页面加载慢，等 30 秒（15 秒时有两家店没等到，2026-10-04）
      const isTarget = () => sameShop(cur.nick, header()) || sameShop(cur.shop, header());
      const opened = await window.otWaitFor(() => isTarget() && inputBox(), 30000);
      if (!opened) { next.skipped = next.skipped.concat(cur.shop + '（未打开，页面显示「' + (header() || '空') + '」）'); await go(); return true; }
      await sleep(1500);
      // 右边「我的订单」里要有这几单之一，才确认是这个卖家；看不到就不填（2026-10-04 用户发现消息被填进了别家的会话）
      await window.otWaitFor(() => document.querySelector('.ww_tab .order-id'), 8000);
      const orders = [...document.querySelectorAll('.ww_tab .order-id')].map(text).filter(x => /^\d{15,20}$/.test(x));
      // 右边「我的订单」只显示和这家最近的一单（2026-10-04 实测：只显示最近新拍的那单）。
      // 所以也认：会话名对得上，且右边第一行的店名就是这单的店铺
      const tabShop = ((document.querySelector('.ww_tab') || {}).innerText || '').split(String.fromCharCode(10))[0].trim();
      const matched = cur.nos.some(no => orders.includes(no)) || (isTarget() && !!tabShop && squash(tabShop) === squash(cur.shop));
      if (!matched || !isTarget()) {
        panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '。当前会话为「' + header() + '」，右侧「我的订单」' + (orders.length ? '中没有这几单' : '无订单信息')
          + '，无法确认是该店铺，未填写消息。请核对后手动发送，或点击「跳过此店」；' + Math.round(waitMax / 60000) + ' 分钟内未处理按跳过。');
        await waitUser('无法确认是该店铺的会话');
        next.skipped = next.skipped.concat(cur.shop + '（未能确认会话）'); await go(); return true;
      }
      // 3 天内已经给这家发过带税号的消息（比如用户自己手动发的，主页还没重新扫描）：不再重复要，直接下一家。
      // 这道保险靠读出来的消息：页面上有消息却一条都没读出来（旺旺页可能改版），就确认不了，不发
      const d3 = new Date(Date.now() - 3 * 864e5), pad = n => String(n).padStart(2, '0');
      const since3 = d3.getFullYear() + '-' + pad(d3.getMonth() + 1) + '-' + pad(d3.getDate());
      if (!q.follow && document.querySelectorAll('.message-item').length && !readMsgs().length) {
        panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '。读不出聊天记录（旺旺页可能改版），无法确认近期是否已发送过，未发送。');
        window.otLog('ask', 'fail', cur.shop + '：' + MAYBE_CHANGED);
        next.skipped = next.skipped.concat(cur.shop + '（' + MAYBE_CHANGED + '）'); await sleep(1500); await go(); return true;
      }
      // 「催卖家」是用户点了这一单要再催一次：不看 3 天内发过没有
      const recent = !q.follow && q.taxId && readMsgs().find(m => m.self && m.time >= since3 && squash(m.text).includes(squash(q.taxId)));
      if (recent) {
        const { askSent } = await chrome.storage.local.get('askSent');
        const all = Object.assign({}, askSent);
        cur.nos.forEach(no => { all[no] = Date.parse(recent.time.replace(' ', 'T')) || Date.now(); });
        await chrome.storage.local.set({ askSent: all });
        next.skipped = next.skipped.concat(cur.shop + '（' + recent.time.slice(5, 16) + ' 已发送过）');
        panel.set(cur.shop + '：' + recent.time + ' 已发送过索要发票的消息，不再重复发送，正在打开下一家…');
        await sleep(1500); await go(); return true;
      }
      const before = sentCount(cur.msg);
      const box = inputBox();
      box.focus();
      if (!squash(box.innerText)) document.execCommand('insertText', false, cur.msg);   // 输入框里已经有字（用户自己在写）就不动
      // 输入框里正好是这次要发的这条：自动发送只发确认过的消息，别把用户自己打的字一起发出去
      const onlyMine = () => squash((inputBox() || {}).innerText) === squash(cur.msg);
      let r;
      if (q.auto && !onlyMine()) {
        panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '。输入框中有其他文字，未自动发送。请核对后手动发送，或点击「跳过此店」；' + Math.round(waitMax / 60000) + ' 分钟内未处理按跳过。');
        r = await waitUser('输入框中有其他文字，未自动发送', () => sentCount(cur.msg) > before);
      } else {
        if (q.auto) {
          // 用户在主页确认过清单：核对过会话后自动点「发送」（按钮也只认完整的一次点击）
          panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '（会话「' + header() + '」，订单已核对）。正在自动发送…');
          await sleep(1200);
          const sb = document.querySelector('button.send-btn');
          if (sb && isTarget() && onlyMine()) for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) sb.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, view: window }));
          await window.otWaitFor(() => sentCount(cur.msg) > before, 10000);
          if (sentCount(cur.msg) <= before) panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '。自动发送未成功，消息保留在输入框中，请核对后手动点击「发送」，或点击「跳过此店」；'
            + Math.round(waitMax / 60000) + ' 分钟内未处理按跳过。');
        } else if (q.follow) panel.set('已填好催促消息，请核对后点发送（' + cur.shop + '，会话「' + header() + '」，订单已核对）。');
        else if (total === 1) panel.set(cur.shop + '（会话「' + header() + '」，订单已核对）：索要发票的消息已填入输入框，请核对后点发送。');
        else panel.set('第 ' + n0 + ' / ' + total + ' 家：' + cur.shop + '（会话「' + header() + '」，订单已核对）。索要发票的消息已填入输入框，请核对后手动点击「发送」；发送后自动打开下一家。');
        r = sentCount(cur.msg) > before ? 'done' : await waitUser(q.auto ? '自动发送未成功' : '等待手动发送', () => sentCount(cur.msg) > before);
      }
      const left = r === 'left', skip = r !== 'done';
      if (left) {
        clearMine(cur.msg);
        await chrome.storage.local.remove('chatQueue');
        panel.buttons([]); panel.detail([]);
        panel.set('会话已从 ' + cur.shop + ' 切换到「' + header() + '」。为避免发错对象，已清除填入的消息并停止。如需继续，请在分拣主页重新操作。');
        return true;
      }
      if (skip || sentCount(cur.msg) <= before) {
        clearMine(cur.msg);                       // 跳过的：填的字也清掉，别留着被带到下一个会话
        next.skipped = next.skipped.concat(cur.shop + (r === 'timeout' ? '（' + Math.round(waitMax / 60000) + ' 分钟内未处理）' : '')); await go(); return true;
      }
      const { askSent } = await chrome.storage.local.get('askSent');
      const all = Object.assign({}, askSent);
      cur.nos.forEach(no => { all[no] = Date.now(); });
      await chrome.storage.local.set({ askSent: all });
      next.sent = next.sent.concat(cur.shop);
      panel.set('已发送至 ' + cur.shop + '，正在打开下一家…');
      await sleep(q.auto ? 8000 + Math.random() * 7000 : 1500);        // 自动发时每家之间隔 8～15 秒，别太快
      await go();
      return true;
    }

    // 按卖家的开票卡片申请：主页「按卖家的开票入口申请」排 cardRun = { id, no, nick, shop, card: { time, title }, at }，再把这个旺旺页
    // 跳到这家的会话（页面会重新加载，所以只在加载时看一次）。找到那张卡片，完整点击「去申请」（页面只认 按下→抬起→click 整套）；
    // 淘宝新开申请页，由 extension/apply-card.js 核对抬头、订单号后提交。
    // 合成的点击不算用户操作，新窗口可能被浏览器拦下：extension/chat-main.js 在页面里记下要打开的申请页地址，被拦了就交给后台打开
    const fullClick = b => { for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, view: window })); };
    async function resumeCard(run) {
      if (!run || !run.id || Date.now() - run.at > 3 * 60000 || run.clicked || run.error) return false;
      if (squash(uidHere()) !== squash(run.nick)) return false;
      const report = async patch => {
        const { cardRun: cur } = await chrome.storage.local.get('cardRun');
        if (cur && cur.id === run.id) await chrome.storage.local.set({ cardRun: Object.assign({}, cur, patch) });
      };
      const stop = async why => { await report({ error: why }); panel.set('按开票入口申请未完成：' + run.shop + '，' + why + '。'); return true; };
      panel.set('按开票入口申请：正在打开 ' + run.shop + ' 的会话…');
      const isTarget = () => sameShop(run.nick, header()) || sameShop(run.shop, header());
      if (!await window.otWaitFor(isTarget, 30000)) return stop('会话未打开（页面显示「' + (header() || '空') + '」）');
      await sleep(1500);
      const cards = () => [...document.querySelectorAll('.message-item')].filter(m => !m.classList.contains('self'))
        .map(m => ({ m, time: text(m.querySelector('.time')), c: cardOf(tplOf(m)) })).filter(x => x.c);
      // 按发来时间找；时间对不上时按标题找，只在标题相近的卡片只有一张时才用（同店几单的卡片标题相近，别点到别的单的卡片）
      const find = () => cards().filter(x => x.time === run.card.time).pop()
        || (ts => ts.length === 1 ? ts[0] : null)(cards().filter(x => I.titleScore(x.c.title, run.card.title) >= 0.8));
      if (!find() && !await loadBack(String(run.card.time || '').slice(0, 10))) return stop('页面出现安全验证');
      const hit = find(), go = hit && goBtn(tplOf(hit.m));
      if (!go) return stop('会话中未找到这张开票卡片');
      go.scrollIntoView({ block: 'center' });
      await sleep(600);
      document.documentElement.removeAttribute('data-ot-open');
      fullClick(go);
      await report({ clicked: Date.now() });
      panel.set('已点击开票卡片上的「去申请」：' + run.shop + '。申请页打开后自动核对并提交。');
      await window.otWaitFor(() => document.documentElement.hasAttribute('data-ot-open'), 6000);
      let info = null;
      try { info = JSON.parse(document.documentElement.getAttribute('data-ot-open') || 'null'); } catch (e) { /* 没记下 */ }
      const APPLY = /^https:\/\/invoice-ua\.taobao\.com\/e-invoice\//;
      if (info && info.blocked && APPLY.test(info.url)) chrome.runtime.sendMessage({ type: 'openJobTab', url: info.url }).catch(() => {});
      else if (!info) {
        const a = tplOf(hit.m).querySelector('a[href*="invoice-ua.taobao.com"]');
        if (a && APPLY.test(a.href)) chrome.runtime.sendMessage({ type: 'openJobTab', url: a.href }).catch(() => {});
      }
      return true;
    }

    async function resumeDownload(q, cur) {
      panel.set('正在打开 ' + cur.shop + ' 的会话，下载卖家发送的文件…');
      const ids = [];
      if (await window.otWaitFor(() => sameShop(cur.nick, header()) || sameShop(cur.shop, header()), 30000)) {
        await sleep(1200);
        for (const j of cur.jobs) {
          const find = () => [...document.querySelectorAll('.file-msg')].find(f => ((f.querySelector('.file-name') || {}).title || text(f.querySelector('.file-name'))) === j.file);
          if (!find()) await loadBack(j.time ? j.time.slice(0, 10) : '');
          const f = find(), a = f && f.querySelector('a.download-file');
          if (!a) continue;
          await window.otSend({ type: 'expectDownload', job: j });
          a.click(); ids.push(j.id);
          await sleep(2500);
        }
        await window.otSend({ type: 'jobsDone', ids });
      }
      const next = Object.assign({}, q, { items: q.items.slice(1), done: q.done + ids.length, at: Date.now() });
      if (next.items.length) { await chrome.storage.local.set({ chatQueue: next }); await sleep(800); goChat(next.items[0].nick); return true; }
      await chrome.storage.local.remove('chatQueue');
      panel.set('已下载 ' + next.done + ' 个文件' + (q.total > next.done ? '，' + (q.total - next.done) + ' 个未找到' : '') + '，结果已送回分拣主页。');
      window.otLog('chatDownload', 'end', '按旺旺名打开会话下载 ' + next.done + ' / ' + q.total + ' 个');
      return true;
    }

    const one = window.otQueue();
    const scan = () => one('scan', async () => {
      try {
        const { invWant, chatScan } = await chrome.storage.local.get(['invWant', 'chatScan']);
        const want = (invWant && invWant.chat) || [];
        if (!want.length) { panel.set('没有需要读取卖家回复的订单（均已开票、已进入淘宝开票流程，或尚未导入订单表）'); return; }
        if (!await window.otWaitFor(() => convItems().length, 15000)) { window.otFail('scan', '旺旺页 15 秒内未显示会话列表（可能未登录或页面已改版）'); return; }
        const since = (invWant.chatSince || '').slice(0, 10);
        const out = Object.assign({}, chatScan && chatScan.convs);
        const items = convItems().filter(it => want.some(o => isConvOf(o, convName(it))));
        // 没读成的会话（点不开、读不出、出错）记下来交给主页：不算进「已读取」，这几单不退回「需向卖家索要」
        const failed = [];
        let k = 0, read = 0;
        const VERIFY = '旺旺页出现安全验证，请在该页面手动完成后，在分拣主页重新点「自动处理发票」';
        for (const it of items) {
          if (window.otNeedsVerify()) { window.otFail('scan', VERIFY); return; }
          const name = convName(it), nos = want.filter(o => isConvOf(o, name)).map(o => o.no);
          panel.set('正在读取第 ' + (++k) + ' / ' + items.length + ' 个会话：' + name);
          try {
            if (!await openConv(it)) { failed.push({ name, nos, why: '会话未打开' }); continue; }
            if (!await loadBack(since)) { window.otFail('scan', VERIFY); return; }
            const msgs = collected();
            const orders = [...document.querySelectorAll('.ww_tab .order-id')].map(text).filter(s => /^\d{15,20}$/.test(s));
            if (unreliable(msgs, out[header()])) { failed.push({ name: header() || name, nos, why: MAYBE_CHANGED }); continue; }
            out[header()] = Object.assign({ at: Date.now(), orders, first: (msgs[0] || {}).time || '' }, I.chatAnalyze(msgs, { taxId: invWant.taxId }));
            read++;
          } catch (e) { failed.push({ name, nos, why: '出错：' + e.message }); window.otLog('scan', 'error', name + '：' + e.message); }      // 一个会话出错不影响别的会话
          await sleep(800 + Math.random() * 800);
        }
        // 左侧最近会话列表里没有的店（聊得太久以前）：用订单页上这一单自己的卖家旺旺名打开，和在订单页点旺旺图标打开的是同一个会话。
        // 一家看完跳下一家（页面会重新加载），进度存在 chatQueue 里；全部看完才写 chatScan，主页的一键处理靠它往下走
        const seenNicks = new Set(Object.keys(out).map(squash));
        const queue = [], seenQ = new Set();
        for (const o of want) {
          if (!o.nick || convItems().some(it => isConvOf(o, convName(it))) || seenNicks.has(squash(o.nick)) || seenQ.has(o.nick)) continue;
          seenQ.add(o.nick);
          queue.push({ nick: o.nick, shop: o.shop, nos: want.filter(x => x.nick === o.nick).map(x => x.no) });
        }
        const noNick = [...new Set(want.filter(o => !o.nick && !convItems().some(it => isConvOf(o, convName(it)))).map(o => o.shop))];
        if (queue.length) {
          await chrome.storage.local.set({ chatQueue: { at: Date.now(), kind: 'scan', since, taxId: invWant.taxId, out, items: queue, noNick, done: items.length, failed, read } });
          panel.set('已读取会话列表中的 ' + read + ' 个会话；另有 ' + queue.length + ' 家店铺不在列表中，正按卖家旺旺名逐个打开…');
          return goChat(queue[0].nick);
        }
        await finishScan(out, failed, read);
        if (noNick.length) panel.set('已读取 ' + read + ' 个会话，结果已送回分拣主页；' + noNick.length + ' 家店铺不在会话列表中且旺旺名未知');
      } catch (e) {
        window.otFail('scan', '读取旺旺回复出错：' + e.message);
      }
    });

    const download = () => one('download', async () => { try {
      const { dlJobs } = await chrome.storage.local.get('dlJobs');
      const jobs = (dlJobs || []).filter(j => j.kind === 'chat');
      if (!jobs.length) { panel.set('没有待下载的文件'); return; }
      await window.otWaitFor(() => convItems().length, 15000);
      const done = [], later = [];
      for (const j of jobs) {
        if (window.otNeedsVerify()) { window.otFail('chatDownload', '旺旺页出现安全验证，请在该页面手动完成后，在分拣主页重新点「自动处理发票」'); break; }
        const it = convItems().find(x => sameShop(j.conv, convName(x)));
        if (!it) { later.push(j); continue; }
        if (!await openConv(it)) continue;
        const find = () => [...document.querySelectorAll('.file-msg')].find(f => ((f.querySelector('.file-name') || {}).title || text(f.querySelector('.file-name'))) === j.file);
        if (!find()) await loadBack(j.time ? j.time.slice(0, 10) : '');
        const f = find(), a = f && f.querySelector('a.download-file');
        if (!a) continue;
        await window.otSend({ type: 'expectDownload', job: j });
        a.click();
        done.push(j.id);
        panel.set('已下载 ' + done.length + ' / ' + jobs.length + ' 个文件');
        await sleep(2500);
      }
      await window.otSend({ type: 'jobsDone', ids: done });   // 交给后台统一删，别和发票页互相盖
      window.otLog('chatDownload', 'end', '下载 ' + done.length + ' / ' + jobs.length + ' 个' + (later.length ? '，' + later.length + ' 个要按旺旺名打开会话' : ''));
      // 不在左侧列表里的会话：按卖家旺旺名打开（会话名可能是店名，拿店名拼地址打不开）；不知道旺旺名的打不开，算未找到
      const items = [...new Set(later.map(j => j.conv))].map(c => ({ nick: (later.find(j => j.conv === c && j.nick) || {}).nick || '', shop: c, jobs: later.filter(j => j.conv === c) }))
        .filter(it => it.nick);
      if (items.length) {
        await chrome.storage.local.set({ chatQueue: { at: Date.now(), kind: 'dl', done: done.length, total: jobs.length, items } });
        panel.set('已下载 ' + done.length + ' 个文件；另有 ' + items.length + ' 个会话不在列表中，正逐个打开下载…');
        return goChat(items[0].nick);
      }
      panel.set('已下载 ' + done.length + ' 个文件' + (jobs.length > done.length ? '，' + (jobs.length - done.length) + ' 个未找到' : '') + '，结果已送回分拣主页。');
    } catch (e) { window.otFail('chatDownload', '下载卖家发送的文件出错：' + e.message); } });

    // 不放按钮：扫描、下载都由分拣主页一键派活，这里只显示进度（用户 2026-10-03：做成全自动，别让人在这里点）
    let onPanel = null;
    const panel = window.otPanel('卖家发票回复', [], id => onPanel && onPanel(id), { top: true });
    panel.set('等待分拣主页分配任务：读取卖家发票回复、下载卖家发送的文件、按开票入口申请');
    chrome.storage.local.get('cardRun').then(r => resumeCard(r.cardRun)).catch(e => { panel.set('按开票入口申请出错：' + e.message); return true; })
      .then(busy => busy || resumeQueue())
      .then(busy => { if (!busy) window.otTakeJob(['scan', 'chatDownload'], (kind) => kind === 'scan' ? scan() : download()); });
  }
})();
