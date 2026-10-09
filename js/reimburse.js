/*
 * reimburse —— 按单位《报销规范手册》整理报销材料的纯逻辑（不碰网页，浏览器和 Node 共用）
 *
 *   - 低值品判断（用户 2026-10-09 定的三条规则 + 两张写死的关键词表，不用 AI）
 *   - 要补的材料：价税合计超过 1000 元（订单页面 + 支付记录）、与科研无关的字样（用途说明）、3D 打印（明细清单）
 *   - 报销批次：到账有差额时找「哪几张票加起来正好等于差额」；导入已整理的文件夹时从文件夹名认出历史批次
 *   - 报销文件夹名「学号_姓名_总金额元」（工程师没有学号：「姓名_总金额元」）
 */
(function (root) {
  'use strict';

  // ── 低值品 ──
  // 规则来源：用户 2026-10-09（结合《报销规范手册》第三章「耗材」）。三条同时满足才是低值品：
  //   ① 单件单价超过 200 元（按订单里这件商品的单价：实付分摊到这件、减去退款，再按留下的件数折算；一张票对多件时按件判断）
  //   ② 发票明细（没有发票时看商品标题、规格）里没有「模块」二字
  //   ③ 属于设备或器械，而不是耗材
  // 判断顺序（前面的先定，定了就不往下看）：
  //   1 单价 ≤ 200 → 不是低值品
  //   2 有「模块」→ 不是低值品
  //   3 用户点标签确认过的同名商品（主页 S.lowval，按商品标题记）→ 沿用
  //   4 关键词：只命中设备器械词 → 低值品；只命中耗材词 → 不是；两边都中、或都没中 → 待确认（黄色「是否低值品？」，交给用户）
  //     一个词被另一个更长的词包住时只算长的那个（「电源线」是耗材，不再算「电源」；「烙铁头」是耗材，不再算「烙铁」；「开关电源」是设备，不再算「开关」）
  // 单字词用正则限定：「计」不算「设计、统计、合计…」，「线」不算「无线、在线、天线…」，「板」不算「平板」
  const DEVICE = [
    '万用表', '钳形表', '电子秤', '天平', '示波器', '信号发生器', '逻辑分析仪', '频谱仪', '稳压电源', '开关电源', '直流电源', '可调电源', '电源',
    '焊台', '烙铁', '电烙铁', '热风枪', '风枪', '电钻', '手电钻', '冲击钻', '电批', '电动螺丝刀', '打磨机', '角磨机', '切割机', '雕刻机', '台钳', '虎钳',
    '显微镜', '放大镜', '测距仪', '卡尺', '千分尺', '测温枪', '热成像', '相机', '摄像机', '云台', '稳定器', '三脚架', '遥控器', '充电器', '电池充电器', '平衡充',
    '3d打印机', '打印机', '工具箱', '热熔胶枪', '胶枪', '吸锡器', '剥线钳', '压线钳', '风扇', '路由器', '交换机', '显示器', '键盘', '鼠标', '硬盘', '笔记本电脑',
    '对讲机', '补光灯', '台灯', '耳机', '音箱', '平板电脑',
    '搅拌器', '离心机', '烘箱', '干燥箱', '恒温箱', '培养箱', '水浴锅', '加热台', '移液器', '移液枪', '真空泵', '气泵',
    /仪/g, /(?<![设统会估合伙算预总共])计(?![算划])/g,
  ];
  const CONSUMABLE = [
    '电池', '锂电', '电芯', /(?<![无在天离曲直主])线/g, '电缆', '电源线', '数据线', '充电线', '端子', '插头', '连接器', '接头', '螺丝', '螺母', '螺栓', '螺柱', '铜柱', '垫片',
    '胶', '胶带', '胶水', /(?<!平)板/g, '碳板', '碳纤维', 'pcb', '亚克力', '泡沫', '树脂', '打印耗材', '线材', '手套', '毛巾', '纸', '砂纸', '硅胶片', '硅胶', '扎带',
    '热缩管', '焊锡', '助焊剂', '模块', '传感器', '芯片', '电阻', '电容', '电感', '二极管', '三极管', '排针', '轴承', '齿轮', '弹簧', '型材', '管', '桨', '螺旋桨',
    '刀片', '钻头', '锯片', '磨片', '烙铁头', '保险丝', '开关', '舵机', '电机', '马达', '电调',
  ];
  const lower = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  // 一张词表在文字里的全部命中：[{ s, e, w, side }]
  function hitsOf(text, list, side) {
    const out = [];
    for (const w of list) {
      if (typeof w === 'string') { for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) out.push({ s: i, e: i + w.length, w, side }); }
      else { w.lastIndex = 0; let m; while ((m = w.exec(text))) { out.push({ s: m.index, e: m.index + m[0].length, w: m[0], side }); if (!m[0].length) w.lastIndex++; } }
    }
    return out;
  }
  // 设备、耗材两边各命中了哪些词（被更长的词包住的不算）
  function lowWords(text) {
    const t = lower(text);
    const all = hitsOf(t, DEVICE, 'dev').concat(hitsOf(t, CONSUMABLE, 'con'));
    const keep = all.filter(h => !all.some(o => o !== h && o.s <= h.s && o.e >= h.e && o.e - o.s > h.e - h.s));
    const pick = side => [...new Set(keep.filter(h => h.side === side).map(h => h.w))];
    return { dev: pick('dev'), con: pick('con') };
  }
  /*
   * x = { unit: 单件单价, title, sku, inv: 发票明细文字（读到才有）, memo: 用户确认过的 'low' / 'no' }
   * 返回 { v, why, fixed }：v = 'low' 低值品 | 'no' 不是 | 'ask' 待确认；单价没超过 200 元时 v = ''（不用管）。
   * fixed：按单价、「模块」定的，用户改不了（界面上的标签不能点）
   */
  function lowJudge(x) {
    const unit = +x.unit || 0;
    if (!(unit > 200 + 0.005)) return { v: '', why: '单价 ' + unit.toFixed(2) + ' 元，未超过 200 元', fixed: true };
    const text = [x.title, x.sku, x.inv].filter(Boolean).join(' ');
    const head = '单价 ' + unit.toFixed(2) + ' 元';
    if (/模块/.test(text)) return { v: 'no', why: head + '，含「模块」，不是低值品', fixed: true };
    if (x.memo === 'low' || x.memo === 'no') return { v: x.memo, why: head + '，已确认为' + (x.memo === 'low' ? '低值品' : '耗材') };
    const w = lowWords(text);
    if (w.dev.length && !w.con.length) return { v: 'low', why: head + '，设备器械（' + w.dev.join('、') + '）' };
    if (w.con.length && !w.dev.length) return { v: 'no', why: head + '，耗材（' + w.con.join('、') + '）' };
    return { v: 'ask', why: head + '，' + (w.dev.length ? '同时像设备（' + w.dev.join('、') + '）和耗材（' + w.con.join('、') + '）' : '无法按关键词判断设备或耗材') + '，请确认' };
  }
  // 单件单价：这件分摊到的实付（已减退款）÷ 留下的件数。部分退款写了金额的，按单价折算退掉了几件（向下取整）
  function unitPrice(share, share0, qty, keep, refAmt) {
    let q = Math.max(1, +qty || 1);
    if (keep != null) q = Math.max(1, keep);
    else if (refAmt != null && share0 > 0) q = Math.max(1, q - Math.floor((refAmt + 0.005) / (share0 / q)));
    return Math.round((+share || 0) / q * 100) / 100;
  }

  // ── 要补的材料（《报销规范手册》3.1）──
  // 开票内容里有可能被认为与科研无关的字样：要写 Word 用途说明，文末附订单页面截图（手册列出的 玩具、体育用品、相框、家具、拖把，另补几类常见的）
  const SENSITIVE = ['玩具', '体育用品', '相框', '家具', '拖把', /运动(?!控制|相机|模块|学)/g, '健身', '装饰', '摆件', '礼品', '零食', '服装', '食品', '饰品'];
  const sensitiveWords = text => { const t = lower(text); return [...new Set(hitsOf(t, SENSITIVE, 's').map(h => h.w))]; };
  // 3D 打印订单：报销都要附明细（零件名称、材料、数量、单价）。「手板」是打样件的行话，SLA / FDM 是两种打印工艺
  const P3D = /3d打印|手板|光固化|(?<![a-z])sla(?![a-z])|(?<![a-z])fdm(?![a-z])/;
  const is3d = text => P3D.test(lower(text));
  // 向卖家索要发票时，3D 打印订单在原消息末尾追加这一句（原消息模板一个字不改）
  const ASK_3D = '另外麻烦提供这单的 3D 打印明细清单（零件名称、材料、数量、单价），谢谢！';
  const BIG = 1000;
  /*
   * 一张票（或一单）要哪些材料：need = { big, sens: [字样], p3d }；have = 已有附件的类型 [...]
   * 返回缺的类型（订单页面由插件自动截图，截不到时也列出来）
   */
  function required(need) {
    const r = [];
    if (need.big || (need.sens && need.sens.length)) r.push('订单页面');
    if (need.big) r.push('支付记录');
    if (need.sens && need.sens.length) r.push('用途说明');
    if (need.p3d) r.push('3D打印明细');
    return r;
  }
  const missing = (need, have) => required(need).filter(k => !(have || []).includes(k));

  // ── 报销批次 ──
  // 到账有差额：在这一批的发票金额里找几张加起来正好等于差额（优先 1～3 张；张数少的在前，同样张数时低值品多的在前——低值品常常单独报）
  // rows: [{ seq, title, amount, low }]；返回 [[row, …], …]
  function diffCombos(rows, diff, maxK) {
    const K = maxK || 3, out = [], c = Math.round(diff * 100);
    if (!(c > 0)) return out;
    const a = rows.map(r => Object.assign({ c: Math.round(r.amount * 100) }, r)).filter(r => r.c > 0 && r.c <= c);
    const walk = (start, left, pick) => {
      if (left === 0) { out.push(pick.slice()); return; }
      if (pick.length >= K || out.length > 2000) return;
      for (let i = start; i < a.length; i++) if (a[i].c <= left) { pick.push(a[i]); walk(i + 1, left - a[i].c, pick); pick.pop(); }
    };
    walk(0, c, []);
    const lows = x => x.filter(r => r.low).length;
    return out.sort((x, y) => x.length - y.length || lows(y) - lows(x)).map(x => x.map(({ c: _, ...r }) => r));
  }
  // 一行字的提示：组合唯一时直接写是哪几张，多解时写有几种、列出张数最少的前 3 种
  function diffHint(rows, diff) {
    const cs = diffCombos(rows, diff);
    if (!cs.length) return '';
    const one = x => x.map(r => (r.seq != null ? r.seq + ' 号 ' : '') + (r.title || '') + ' ' + (+r.amount).toFixed(2)).join(' + ');
    if (cs.length === 1) return '差额可能是：' + one(cs[0]);
    return '有 ' + cs.length + ' 种可能组合：' + cs.slice(0, 3).map(one).join('；') + (cs.length > 3 ? '；…' : '');
  }
  // 汉字数字（第一批、第十二批）→ 数字
  function cnNum(s) {
    s = String(s || '');
    if (/^\d+$/.test(s)) return +s;
    const d = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let n = 0, cur = 0;
    for (const ch of s) {
      if (ch in d) cur = d[ch];
      else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
      else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
      else return NaN;
    }
    return n + cur;
  }
  const batchNo = name => { const m = /第\s*([一二三四五六七八九十百零〇两\d]+)\s*批/.exec(String(name || '')); return m ? cnNum(m[1]) : NaN; };
  // 下一批默认叫「第 N 批」：已有批次里最大的序号加一（导入的历史批次也算）
  function nextBatchName(batches) {
    const ns = (batches || []).map(b => batchNo(b.name)).filter(n => n > 0);
    return '第 ' + (Math.max(ns.length ? Math.max(...ns) : 0, (batches || []).length) + 1) + ' 批';
  }
  // 以前整理好的报销文件夹名「YYMMDD_……第X批……_金额_报销给某人」（用户手工整理的几批就是这样命名的）→ 历史批次
  function parseBatchDir(dir) {
    const m = /^(\d{2})(\d{2})(\d{2})_(.*第\s*[一二三四五六七八九十百零〇两\d]+\s*批.*?)_(\d+(?:\.\d{1,2})?)元?_报销给(.+)$/.exec(String(dir || '').trim());
    if (!m) return null;
    const date = '20' + m[1] + '-' + m[2] + '-' + m[3];
    if (isNaN(Date.parse(date))) return null;
    const nm = (/第\s*[一二三四五六七八九十百零〇两\d]+\s*批/.exec(m[4]) || [m[4]])[0].replace(/\s+/g, '');
    return { date, name: nm, label: m[4], amount: +m[5], to: m[6], dir: String(dir).trim() };
  }
  // 报销文件夹名：学号_姓名_总金额元（手册 3.2.2，例如「12345678_张三_256.80元」）；没有学号时「姓名_总金额元」
  const clean = s => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '');
  const packDirName = (person, total) => [clean(person && person.sid), clean(person && person.name), (+total || 0).toFixed(2) + '元'].filter(Boolean).join('_');

  const api = { DEVICE, CONSUMABLE, SENSITIVE, ASK_3D, BIG, lowWords, lowJudge, unitPrice, sensitiveWords, is3d, required, missing,
                diffCombos, diffHint, cnNum, batchNo, nextBatchName, parseBatchDir, packDirName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reimburse = api;
})(typeof self !== 'undefined' ? self : this);
