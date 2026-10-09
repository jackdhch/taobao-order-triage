// 自检：合并规则 + 关键词建议。node tools/selftest.mjs（数据全部虚构）
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const req = createRequire(import.meta.url);
const N = req('../js/normalize.js'), C = req('../js/classify.js'), I = req('../js/invoice.js'), Z = req('../js/zip.js');

const table = () => N.rowsToOrders([
  ['订单号', '订单提交时间', '订单状态', '店铺名称', '商品名称', '型号款式', '商品数量', '商品金额', '实付金额'],
  ['100000000000000001', '2026-07-10 10:00:00', '交易成功', '某五金店', '不锈钢螺丝 M3', 'M3×12', '1', '19.80', '88.60'],
  ['', '', '', '', '数显游标卡尺 0-150mm', '标准款', '1', '68.80', ''],
  ['100000000000000002', '2026-06-01 09:00:00', '交易成功', '某数码店', '手机壳 磁吸', '单壳', '1', '39.00', '39.00'],
]);
const scraped = [
  { no: '100000000000000001', lines: [
    { title: '数显游标卡尺 0-150mm 高精度', img: 'https://img.alicdn.com/b.jpg', refund: '退款成功' },
    { title: '不锈钢螺丝 M3 杯头', img: 'https://img.alicdn.com/a.jpg' }] },
  { no: '999999999999999999', lines: [{ title: '订单表里没有的', img: 'https://img.alicdn.com/x.jpg' }] },
];

// 有订单表：只补图片/退款，按标题对上每件，不新增订单
let o = table();
assert.deepEqual(N.missingImages(o), { nos: ['100000000000000001', '100000000000000002'], from: '2026-06-01' });
const r = N.mergeScraped(o, scraped);
assert.deepEqual(r, { matched: 1, added: 0, skipped: 1, filled: 2, unmatched: 0 });
assert.equal(o.length, 2);
assert.equal(o[0].lines[0].img, 'https://img.alicdn.com/a.jpg');
assert.equal(o[0].lines[1].refund, '退款成功');
assert.equal(N.refundState(o[0].lines[1], o[0]), 'refunded');
assert.deepEqual(N.missingImages(o), { nos: ['100000000000000002'], from: '2026-06-01' });

// 抓取数据比订单表少一件：对不上的计数，不乱挂
o = table();
assert.equal(N.mergeScraped(o, [{ no: '100000000000000001', lines: [scraped[0].lines[1]] }]).unmatched, 1);

// 没有订单表时才按抓取数据建单
o = [];
assert.equal(N.mergeScraped(o, scraped, { addNew: true }).added, 2);

// 关键词建议：漏判的商品里反复出现、另一类没出现过的词建议加入；误导判断的词建议移出
const rules = { lab: { 2: ['螺丝'], 1: [] }, personal: { 2: ['零食'], 1: ['家用'] }, unsure: [] };
const row = (title, manual) => {
  const r = C.classify({ title, sku: '' }, { shop: '' }, { compiled: C.compile(rules) });
  return { title, text: title, manual, auto: r.cat };
};
const sg = C.suggest([
  row('CH340 USB转串口模块', 'lab'), row('CH340G 刷机线 下载器', 'lab'), row('CH340 串口线 1米', 'lab'),
  row('家用小工具 螺丝 M3', 'lab'), row('家用 螺丝 套装', 'lab'),
  row('网红零食大礼包', 'personal'), row('串口', undefined),
], rules);
assert.deepEqual(sg.add.map(a => [a.word, a.side, a.n]), [['CH340', 'lab', 3]]);
assert.deepEqual(sg.remove.map(r => [r.word, r.side, r.wrong, r.right]), [['家用', 'personal', 2, 0]]);
// 自动判成个人的商品也算反例：「桌面」在自动判个人的零食里出现过，就不推荐成实验室词
const sa = C.suggest([row('桌面 电源模块支架', 'lab'), row('桌面 示波器支架', 'lab'), row('网红零食 桌面摆件', undefined)], rules);
assert.ok(!sa.add.some(a => a.word === '桌面'), JSON.stringify(sa.add));
// 模糊词和跨着模糊词的片段不推荐（「收纳」本身、「线收」）
const rv = Object.assign({}, rules, { unsure: ['收纳'] });
const sv = C.suggest([row('数据线收纳 魔术贴', 'lab'), row('桌面数据线收纳盒', 'lab')], rv);
assert.ok(sv.add.every(a => !/收|纳/.test(a.word)), JSON.stringify(sv.add));

// 订单表之前的订单（淘宝只能导出最近几个月）：早于 addBefore 的按抓取建单，并带上开票按钮；表时间段里表上没有的仍不建
o = [{ no: '300', time: '2026-05-21 10:00', shop: '甲', lines: [{ id: '300#0', title: '螺丝', img: '' }] }];
const r2 = N.mergeScraped(o, [{ no: '301', time: '2026-03-02 09:00', shop: '乙', inv: '申请开票', lines: [{ title: '舵机' }] },
                       { no: '302', time: '2026-06-01', shop: '丙', lines: [{ title: '电调' }] },
                       { no: '303', time: '', shop: '丁', lines: [{ title: '不知道日期' }] },
                       { no: '304', time: '2025-12-30', shop: '戊', lines: [{ title: '比用户填的日期还早' }] }], { addRange: { from: '2026-01-01', before: '2026-05-21' } });
assert.deepEqual([r2.added, r2.skipped], [1, 3]);
assert.deepEqual([o[1].no, o[1].source, o[1].inv, o[1].time.slice(0, 10), o[1].older], ['301', 'scrape', '申请开票', '2026-03-02', true]);

// 文字里有别的 20 位数字（银行账号、老式 20 位税号）：老式发票取 8 位号码；全电发票取年份打头的那个
assert.equal(I.parseInvoiceText('电子发票 发票代码 发票号码 开票日期 纳税人识别号 031002100111 07921694 2026年03月13日 11010119900101123401 ¥52.00').invNo, '07921694');
assert.equal(I.parseInvoiceText('电子发票 发票号码：07921699 开票日期：2026年03月13日 识别号 11010119900101123401 ¥52.00').invNo, '07921699');
assert.equal(I.parseInvoiceText('电子发票（普通发票） 发票号码： 开票日期： 开户行及账号 31001234567890123456 26990000001234567890 2026年08月01日 ¥9.90').invNo, '26990000001234567890');
assert.equal(I.parseInvoiceText('电子发票 发票号码： 开票日期： 2699000000123456 7 890 2026 年 08 月 01 日 备注 40000000000000000001 ¥9.90').invNo, '26990000001234567890');
// 订单页状态和订单表又一致了、或新订单表更新了状态：旧的订单页状态作废（不然交易关闭的单还按交易成功算）
o = [{ no: '400', time: '2026-06-01', status: '等待买家确认收货', statusLive: '交易成功', shop: '甲', lines: [{ id: '400#0', key: 'k400', title: '螺丝' }] }];
N.mergeExport(o, [{ no: '400', time: '2026-06-01', status: '交易关闭', shop: '甲', lines: [{ id: '400#0', key: 'k400', title: '螺丝' }] }]);
assert.equal(o[0].statusLive, undefined);
assert.equal(N.refundState(o[0].lines[0], o[0]), 'closed');
// 同一个商品买了两个规格、订单页顺序和订单表相反：退款按规格贴对
const tw = [{ title: '不锈钢螺丝', sku: 'M3x8' }, { title: '不锈钢螺丝', sku: 'M4x10' }];
N.fillLines(tw, [{ title: '不锈钢螺丝', sku: 'M4x10', refund: '退款成功' }, { title: '不锈钢螺丝', sku: 'M3x8' }]);
assert.deepEqual(tw.map(l => l.refund || ''), ['', '退款成功']);

// 时间统一成 YYYY-MM-DD：自动翻页拿它和页面日期比大小
assert.equal(N.normTime('2026/5/21 10:00'), '2026-05-21 10:00');
assert.equal(N.normTime('2026年5月3日'), '2026-05-03');
assert.equal(N.normTime('2026-07-10 09:00:00'), '2026-07-10 09:00:00');
assert.equal(N.normTime('46163.5'), '2026-05-21 12:00:00');         // xlsx 里没设格式的日期序号（46023 = 2026-01-01）
assert.equal(N.rowsToOrders([['订单号', '订单提交时间', '商品名称', '实付金额'], ['1', '2026/6/9 8:00', '某商品', '1']])[0].time, '2026-06-09 8:00');

// 先按抓取数据建单、后导入订单表：标题写法不同，图片要按相似度挪过去，手动判断跟着 key 走
o = [];
N.mergeScraped(o, [{ no: '100000000000000001', lines: [{ title: '不锈钢螺丝 M3 杯头【包邮】', img: 'https://img.alicdn.com/a.jpg' },
                                                       { title: '数显游标卡尺 0-150mm', img: 'https://img.alicdn.com/b.jpg', refund: '退款成功' }] }], { addNew: true });
const oldKeys = o[0].lines.map(l => l.key);
const m2 = N.mergeExport(o, table().slice(0, 1));
assert.equal(o[0].source, 'export');
assert.deepEqual(o[0].lines.map(l => l.img), ['https://img.alicdn.com/a.jpg', 'https://img.alicdn.com/b.jpg']);
assert.equal(o[0].lines[1].refund, '退款成功');
assert.deepEqual(Object.keys(m2.keyMap).sort(), oldKeys.slice().sort());
assert.deepEqual(Object.values(m2.keyMap).sort(), o[0].lines.map(l => l.key).sort());

// 发票：税号校验位（GB 32100 标准里的示例号码，和一个虚构号码）
assert.equal(I.taxIdOk('91350100M000100Y43'), true);
assert.equal(I.taxIdOk('121000009999999996'), true);
assert.equal(I.taxIdOk('121000009999999995'), false);                  // 错一位
assert.equal(I.taxIdOk('91350100M000100Y4'), false);                   // 少一位
assert.equal(I.renderMsg('订单 {订单号} ¥{金额} {抬头}/{税号}', { no: '1', amount: 9.9, title: '某大学', taxId: 'X' }), '订单 1 ¥9.9 某大学/X');

// 认出电子发票文件名
assert.deepEqual(I.parseInvoiceName('dzfp_12345678901234567890_某大学_20260810202641.pdf'),
  { invNo: '12345678901234567890', title: '某大学', time: '20260810202641', ext: 'pdf', sure: true });
assert.equal(I.parseInvoiceName('产品说明书.pdf'), null);
assert.equal(I.parseInvoiceName('发票.ofd').ext, 'ofd');

// 聊天分析：只算第一次要发票之后对方发来的；没要过的会话只收明显是发票的文件
const chat = [
  { self: false, time: '2026-08-01 10:00:00', file: { name: '产品资料.pdf', size: '1MB' } },
  { self: true, time: '2026-08-02 09:00:00', text: '需要发票' },
  { self: false, time: '2026-08-02 09:05:00', text: '收到，发您邮箱可以吗' },
  { self: false, time: '2026-08-03 12:00:00', file: { name: 'dzfp_12345678901234567890_某大学_20260803120000.pdf', size: '144KB' } },
  { self: false, time: '2026-08-03 12:01:00', img: 'https://img.alicdn.com/qr.png' },
];
const an = I.chatAnalyze(chat);
assert.deepEqual(an.asks, [{ time: '2026-08-02 09:00:00', text: '需要发票', nos: [] }]);
assert.deepEqual(an.files.map(f => f.name), ['dzfp_12345678901234567890_某大学_20260803120000.pdf']);
assert.equal(an.images.length, 1);
assert.equal(an.email.length, 1);
assert.deepEqual(I.chatAnalyze(chat.filter(m => !m.self)).files.map(f => f.name), ['dzfp_12345678901234567890_某大学_20260803120000.pdf']);

// 每单状态的优先级
const want = { title: '某大学' };
assert.equal(I.status({ refunded: true }, want).key, 'none');
assert.equal(I.status({ plat: { tab: 'issued', title: '企业-某大学', type: '普通发票-电子' } }, want).key, 'ready');
assert.equal(I.status({ plat: { tab: 'issued', title: '个人' } }, want).key, 'wrong');
assert.equal(I.status({ plat: { tab: 'issued', title: '企业-某大学', type: '普通发票-纸质', canDownload: false } }, want).key, 'paper');
// 「下载到本地」按钮改名没认出来时，类型写着「电子」的不判成纸质（不然显示「随快递寄送」，等一个不会到的快递）
assert.equal(I.status({ plat: { tab: 'issued', title: '企业-某大学', type: '电子普通发票', canDownload: false } }, want).key, 'ready');
// 不是发票的 PDF：读得出不少字却没有「发票」字样；读不出字的（扫描版）不算
assert.equal(I.notInvoiceText('虚构 产品说明书 型号 X1 额定电压 5V 额定电流 1A 使用前请仔细阅读本说明 保修一年'), true);
assert.equal(I.notInvoiceText('电子发票（普通发票） 发票号码 26990000001234567890 开票日期 2026年08月01日 价税合计 ¥9.90'), false);
assert.equal(I.notInvoiceText(''), false);
assert.equal(I.status({ plat: { tab: 'issued', title: '企业-某大学' }, got: [{ file: 'a.pdf' }] }, want).key, 'done');
// 「申请中」「开票中」合并成一种状态，进度原文、商家剩余处理时间放在说明里
assert.equal(I.status({ plat: { tab: 'applying', progress: '开票中' } }, want).label, '已申请淘宝开票，等待商家开具');
assert.equal(I.status({ plat: { tab: 'applying', progress: '申请中' } }, want).label, '已申请淘宝开票，等待商家开具');
assert.ok(I.status({ plat: { tab: 'applying', progress: '开票中', date: '2026-10-01', remain: '商家还有8天57分37秒处理时间' } }, want).detail.includes('商家还有8天57分37秒处理时间'));
assert.equal(I.status({ chat: I.chatAnalyze(chat.slice(0, 3).filter(m => m.self)) }, want).label, '已向卖家索要发票，等待回复');
assert.equal(I.status({ chat: an }, want).key, 'replied');
assert.equal(I.status({ chat: I.chatAnalyze(chat.slice(0, 3).filter(m => m.self)) }, want).key, 'asked');
assert.equal(I.status({ plat: { tab: 'unapplied' } }, want).key, 'apply');
assert.equal(I.status({}, want).key, 'ask');
assert.equal(I.saveName({ time: '2026-08-03 12:00', amount: 27.3, shop: '某某/旗舰 店', no: '123' }), '2026-08-03_27.3_某某旗舰店_123.pdf');

// 一家店两单共用一个会话：带订单号的要发票，回复归那一单；手打的「需要发票」在两单的店里标成分不清
const two = I.chatAnalyze([
  { self: true, time: '2026-08-01 09:00:00', text: '您好，订单 500000000000000001 需要开发票' },
  { self: false, time: '2026-08-01 10:00:00', file: { name: 'dzfp_11111111111111111111_某大学_20260801100000.pdf' } },
  { self: true, time: '2026-08-05 09:00:00', text: '您好，订单 500000000000000002 需要开发票' },
  { self: false, time: '2026-08-05 10:00:00', file: { name: 'dzfp_22222222222222222222_某大学_20260805100000.pdf' } },
]);
assert.deepEqual(I.chatForOrder(two, '500000000000000001', 2).files.map(f => f.name), ['dzfp_11111111111111111111_某大学_20260801100000.pdf']);
assert.deepEqual(I.chatForOrder(two, '500000000000000002', 2).files.map(f => f.name), ['dzfp_22222222222222222222_某大学_20260805100000.pdf']);
assert.equal(I.status({ chat: I.chatForOrder(two, '500000000000000003', 3) }, want).key, 'ask');      // 这家店第三单从没要过
// 税号是一长串数字时，不能被当成订单号（不然会以为是替别的单要的发票）
assert.deepEqual(I.chatAnalyze([{ self: true, time: '1', text: '需要发票 某大学 121000009999999996' }], { taxId: '121000009999999996' }).asks[0].nos, []);
// 税号里夹着的一长串数字不算订单号（税号末尾常是字母，前面一长串都是数字）
assert.deepEqual(I.chatAnalyze([{ self: true, time: '1', text: '某大学 121000009999999X0X' }], { taxId: '121000009999999X0X' }).asks[0].nos, []);
assert.deepEqual(I.chatAnalyze([{ self: true, time: '1', text: '订单 500000000000000001 的发票' }]).asks[0].nos, ['500000000000000001']);
// 下单之前的要发票不算这单的
const old = I.chatAnalyze([{ self: true, time: '2026-06-07 06:00:00', text: '需要发票' }, { self: false, time: '2026-06-08 00:00:00', file: { name: 'dzfp_11111111111111111111_某大学_20260608000000.pdf' } },
                           { self: true, time: '2026-08-27 02:00:00', text: '发票' }, { self: false, time: '2026-08-27 04:00:00', file: { name: 'dzfp_22222222222222222222_某大学_20260827000000.pdf' } }]);
assert.deepEqual(I.chatForOrder(old, '500000000000000009', 1, '2026-08-08 10:00:00').files.map(f => f.name), ['dzfp_22222222222222222222_某大学_20260827000000.pdf']);
const hand = I.chatAnalyze(chat);                                                                        // 手打的「需要发票」，没写订单号
assert.equal(I.chatForOrder(hand, '500000000000000001', 1).shared, false);
assert.equal(I.chatForOrder(hand, '500000000000000001', 2).shared, true);
assert.equal(I.status({ chat: I.chatForOrder(hand, '500000000000000001', 2) }, want).shared, true);

// 已整理过的发票：平台票按开票日期+金额；卖家票按金额+下单后 180 天内且只有一张
const idx = [{ date: '2026-08-10', amount: 27.3, file: 'a.pdf' }, { date: '2026-08-20', amount: 9.9, file: 'b.pdf' }, { date: '2026-08-21', amount: 9.9, file: 'c.pdf' }];
assert.equal(I.findHave(idx, { time: '2026-08-01', amount: 27.3 }, { tab: 'issued', date: '2026-08-10', amount: 27.3 }).file, 'a.pdf');
assert.equal(I.findHave(idx, { time: '2026-08-01', amount: 27.3 }, { tab: 'issued', date: '2026-08-11', amount: 27.3 }), null);
assert.equal(I.findHave(idx, { time: '2026-08-01 10:00', amount: 27.3 }).file, 'a.pdf');
assert.equal(I.findHave(idx, { time: '2026-08-01', amount: 9.9 }), null);                                  // 两张金额一样，不猜
assert.equal(I.findHave(idx, { time: '2026-09-01', amount: 27.3 }), null);                                 // 发票早于下单
// 一对一：两单抢一张票都不认；平台正在申请的不按金额猜；一单一张的认
{
  const ix = [{ invNo: '1', date: '2026-07-25', amount: 24, file: '248.pdf' }, { invNo: '2', date: '2026-07-20', amount: 28, file: '202.pdf' },
              { invNo: '3', date: '2026-07-30', amount: 73.57, file: '259.pdf' }];
  const os = [{ no: 'a', time: '2026-07-22', amount: 24 }, { no: 'b', time: '2026-07-22', amount: 24 }, { no: 'c', time: '2026-07-06', amount: 28 },
              { no: 'd', time: '2026-07-27', amount: 73.57 }];
  const m = I.matchHave(ix, os, no => (no === 'c' ? { tab: 'applying' } : null));
  assert.deepEqual([...m.have.keys()], ['d']);
  assert.deepEqual([...m.contested.keys()].sort(), ['a', 'b']);
}
assert.equal(I.status({ have: idx[0], plat: { tab: 'issued', title: '企业-某大学' } }, want).key, 'have');

// PDF 抽出来的文字：标签和值分开、字间夹空格（照真实发票的排列，内容虚构）
const pt = '电 子 发 票 （ 普 通 发 票 ） 发 票 号 码： 开票 日期： 购 买 方 信 息 统一社会信用代码/ 纳税人识别号 ： 名称： 名称： 项目名称 金 额 税 额 价 税合 计（ 小写） '
  + '12345678901234567890 2026 年 08 月 17 日 某大学 121000009999999996 ¥ 17.61 ¥ 2.29 ¥ 19.90 壹拾玖圆玖角';
assert.deepEqual(I.parseInvoiceText(pt, '某大学'), { invNo: '12345678901234567890', date: '2026-08-17', amount: 19.9, isInvoice: true, titleOk: true });
assert.equal(I.parseInvoiceText('产品说明书 型号 12345678901234567890').isInvoice, false);
assert.equal(I.parseInvoiceText('发票号码 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 开票日期').invNo, '12345678901234567890');     // 逐字隔开的号码
assert.equal(I.parseInvoiceText('电子发票 发票代码 发票号码 开票日期 031002100111 07921694 2026年03月13日 ¥52.00').invNo, '07921694');
assert.equal(I.parseInvoiceText('电子发票 发票号码： 开票日期： 1234567890123456 7 890 2026 年 06 月 08 日 ¥32.20').invNo, '12345678901234567890');   // 拆成几段、粘着年份
assert.equal(I.parseInvoiceText('电子发票 发票号码： 开票日期： 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 2 0 2 6 年 0 7 月 2 0 日 ¥31.33').invNo, '12345678901234567890');   // 老式：12 位代码 + 8 位号码

// 读表：单元格写成 <v xml:space="preserve">（商品名首尾有空格时 Excel 这么存）也要读出来，不能整单丢掉
{
  const fs = await import('node:fs');
  const T = req('../js/xlsx-lite.js');
  const b = fs.readFileSync(new URL('./fixtures/xml-space-preserve.xlsx', import.meta.url));
  const got = N.rowsToOrders(await T.read(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'x.xlsx'));
  assert.equal(got.length, 2, '两单都要读进来');
  assert.equal(got[1].lines[0].title, '虚构导热硅胶 末尾有空格');
  assert.deepEqual(got.dropped, []);
}

// 2026-10-03 用户规则：补差价 / 邮费一律待定；同店判过一件实验室 → 默认实验室；判过的补差价不推给同店
{
  const compiled = C.compile(C.DEFAULT_RULES);
  const shopMemory = new Map([['甲店', { lab: 1, personal: 0 }], ['乙店', { lab: 1, personal: 1 }], ['丙店', { lab: 0, personal: 2 }]]);
  const titleMemory = new Map([['补差价专用', 'personal']]);
  const ctx = { compiled, shopMemory, titleMemory, norm: s => s };
  const cl = (title, shop) => C.classify({ title, sku: '' }, { shop }, ctx);
  assert.equal(cl('补差价专用', '甲店').cat, 'unsure');
  assert.equal(cl('补差价专用', '甲店').via, 'surcharge');
  assert.equal(cl('邮费补拍链接 1元', '丙店').cat, 'unsure');
  assert.equal(cl('随便一个看不出来的东西', '甲店').cat, 'lab');
  assert.equal(cl('随便一个看不出来的东西', '甲店').via, 'shop');
  assert.notEqual(cl('随便一个看不出来的东西', '乙店').via, 'shop');      // 同店两种都判过：不跟店铺
  assert.equal(cl('随便一个看不出来的东西', '丙店').cat, 'personal');
  assert.ok(C.isSurcharge('运费补差') && !C.isSurcharge('XT60 插头'));
}
// 下载的发票按 PDF 金额、开票日期核对订单（同店多单）
{
  const orders = [
    { no: '100000000000000101', shop: '甲店', time: '2026-07-01 10:00:00', amount: 20 },
    { no: '100000000000000102', shop: '甲店', time: '2026-07-10 10:00:00', amount: 35 },
    { no: '100000000000000103', shop: '甲店', time: '2026-07-20 10:00:00', amount: 15 },
    { no: '100000000000000104', shop: '乙店', time: '2026-07-05 10:00:00', amount: 35 },
    { no: '100000000000000105', shop: '甲店', time: '2026-08-01 10:00:00', amount: 35 },
  ];
  const f = (no, amount, date, extra) => Object.assign({ file: '订单分拣-发票/2026-07-01_x_' + no + '.pdf', amount, date, titleOk: true }, extra);
  const r = I.checkFiles([
    f('100000000000000101', 20, '2026-07-02'),                     // 对得上
    f('100000000000000101', 20, '2026-06-29'),                     // 开票早 2 天：淘宝时间有误差，放过
    f('100000000000000103', 35, '2026-07-12'),                     // 归错：同店 102 对得上（105 下单比开票晚，不算）
    f('100000000000000101', 35, '2026-08-03'),                     // 102、105 都对得上
    f('100000000000000101', 50, '2026-07-21'),                     // 102 + 103 合开
    f('100000000000000103', 12.5, '2026-04-28'),                   // 比下单早很多：以前的票
    f('100000000000000101', 99, '2026-07-02'),                     // 金额对不上
    f('100000000000000101', 23, '2026-07-02'),                     // 比实付多一点：按优惠前的价开
    f('100000000000000101', 19.2, '2026-07-02'),                   // 比实付少 0.8：没关系
    f('100000000000000101', 17.5, '2026-07-02'),                   // 比实付少 2.5：要提醒
    f('100000000000000101', 20, '2026-07-02', { titleOk: false }), // 抬头不对
    { file: 'random.pdf', amount: 20, date: '2026-07-02' },
  ], orders);
  assert.deepEqual(r.map(x => x.kind), ['ok', 'ok', 'move', 'many', 'merged', 'old', 'amount', 'more', 'less', 'short', 'title', 'none']);
  // 按用券前价格开的票（实付 10.00、票面 10.50），同店正好有一单实付 10.50：先认文件名那一单（多一点），不挪走
  const coupon = [{ no: '100000000000000201', shop: '丙店', time: '2026-07-01 10:00:00', amount: 10 }, { no: '100000000000000202', shop: '丙店', time: '2026-07-02 10:00:00', amount: 10.5 }];
  assert.equal(I.checkFiles([f('100000000000000201', 10.5, '2026-07-03')], coupon)[0].kind, 'more');
  // 少 1 元以内也先认它；同店另一单正好等于票面也不挪
  assert.equal(I.checkFiles([f('100000000000000202', 10, '2026-07-03')], coupon)[0].kind, 'less');
  // 明显不符（多出 3 成以上）才去同店找：正好是另一单的金额 → 挪过去
  assert.equal(I.checkFiles([f('100000000000000201', 30, '2026-07-03')], coupon.concat({ no: '100000000000000203', shop: '丙店', time: '2026-07-02', amount: 30 }))[0].to, '100000000000000203');
  assert.equal(r[2].to, '100000000000000102');
  assert.deepEqual(r[3].nos, ['100000000000000102', '100000000000000105']);
  assert.deepEqual(r[4].nos, ['100000000000000102', '100000000000000103']);
}
// 订单详情页判断退款（照真实页面文字的排列，内容虚构）
{
  const one = '虚构热缩管 套装 黑色 内径10mm[不带胶] 退货宝 7天无理由退货 加入购物车售后成功 退款成功 平台支持退款 ￥9.90 ￥10.00 x1 付款详情 商品总价 ￥10.00 运费 ￥0.00 实付款 ￥9.90';
  assert.deepEqual(I.detailRefund(one), { items: 1, refundedItems: 1, refunded: true, lines: [{ unit: 9.9, qty: 1, refundedQty: 1, refund: 9.9, stated: false }] });
  const two = '商品A 退款成功 ￥10.00 x1 商品B 申请售后 ￥5.00 ￥6.00 x2 实付款 ￥20.00';
  assert.deepEqual(I.detailRefund(two), { items: 2, refundedItems: 1, refunded: false, lines: [{ unit: 10, qty: 1, refundedQty: 1, refund: 10, stated: false }, { unit: 5, qty: 2, refundedQty: 0, refund: 0, stated: false }] });
  // 部分退款（照真实页面文字的排列，内容虚构：买 3 个退 2 个）
  const km = '虚构舵机 黑色 退货宝 极速退款 7天无理由退货 加入购物车申请售后 退款成功 支付宝¥20.00 ￥10.00 ￥10.50 x3 付款详情 商品总价 ￥31.50';
  assert.deepEqual(I.detailRefund(km), { items: 1, refundedItems: 1, refunded: false, lines: [{ unit: 10, qty: 3, refundedQty: 2, refund: 20, stated: true }] });
  assert.equal(I.detailRefund('交易成功 ￥22.00 x1').refunded, false);
  // 部分退款（虚构）：实付 20、退了 2 元（价保之类）→ 不算退掉，退款金额 2
  assert.deepEqual(I.detailRefund('某商品 申请售后 退款成功 支付宝¥2.00 ￥20.00 ￥22.00 x1 付款详情').lines, [{ unit: 20, qty: 1, refundedQty: 0, refund: 2, stated: true }]);
  // 退了单价一半以上（价保、赔偿：单价 9.90 退 5.00）：不能四舍五入成整件退，整单照样开票（以前被当成整单退款，悄悄漏报）
  const half = I.detailRefund('虚构 镊子 退款成功 支付宝¥5.00 ￥9.90 ￥12.00 x1 付款详情');
  assert.equal(half.refunded, false);
  assert.deepEqual(half.lines, [{ unit: 9.9, qty: 1, refundedQty: 0, refund: 5, stated: true }]);
  // 写了金额、而且退够了整件：算退完
  assert.equal(I.detailRefund('虚构 镊子 退款成功 支付宝¥9.90 ￥9.90 x1').refunded, true);
}
// zip：CRC32 对得上标准值；打出来的包结构对（文件数、中文名用 UTF-8 标志）
{
  assert.equal(Z.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const z = Z.makeZip([{ name: '报销/261_260801_9.90-测试-1件.pdf', data: new TextEncoder().encode('%PDF-1.4 x') }, { name: '报销/汇总.csv', data: new Uint8Array([1, 2, 3]) }], new Date(2026, 9, 5, 12, 0, 0));
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint16(6, true), 0x0800);
  assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(z.length - 22 + 10, true), 2);
  fs.writeFileSync('/tmp/ot-selftest.zip', z);
}
// 给卖家的消息：和用户真实发过的格式一字不差（没填邮箱就不带）；一家几单合成一条；填了邮箱带上
{
  const v = { title: '某大学', taxId: '121000009999999996' };
  assert.equal(I.renderMsg('', Object.assign({ no: '5190000000000000201', date: '2026-08-14', amount: 27 }, v)),
    '您好，订单 5190000000000000201（26.8.14，¥27）需要开电子普通发票：抬头 某大学，税号 121000009999999996，内容按商品明细。开好后麻烦直接把 PDF 文件发在这个聊天窗口，谢谢！');
  const two = I.renderMsg('', Object.assign({ orders: [{ no: '1', date: '2026-07-01', amount: 3.5 }, { no: '2', date: '2026-07-20', amount: 10 }], email: 'a@b.cn' }, v));
  assert.ok(two.startsWith('您好，订单 1（26.7.1，¥3.5）、2（26.7.20，¥10）需要开') && two.includes('邮箱 a@b.cn，内容'), two);
}
// 开票卡片：卖家发来的「请填写发票申请」卡片单独记，不算图片；按商品标题归单；优先于「已向卖家索要」；提交过申请就算已进入淘宝开票流程
{
  const msgs = [
    { self: true, time: '2026-09-01 10:00:00', text: '您好，需要开发票' },
    { self: false, time: '2026-09-02 09:00:00', img: 'https://img.alicdn.com/bg.png', card: { title: '虚构 不锈钢镊子 防静电 尖头', price: '139.00' } },
  ];
  const a = I.chatAnalyze(msgs);
  assert.equal(a.images.length, 0);                                                   // 卡片里的背景图不算卖家发来的图片
  assert.deepEqual(a.cards, [{ time: '2026-09-02 09:00:00', title: '虚构 不锈钢镊子 防静电 尖头', price: '139.00' }]);
  const peers = [{ no: '1', time: '2026-08-20', titles: ['虚构 不锈钢镊子 防静电 尖头 ESD-15'] }, { no: '2', time: '2026-08-25', titles: ['虚构 热风枪 858D'] }];
  assert.equal(I.chatForOrder(a, '1', 2, '2026-08-20', peers).cards.length, 1);
  assert.equal(I.chatForOrder(a, '1', 2, '2026-08-20', peers).cards[0].shared, false);
  assert.equal(I.chatForOrder(a, '2', 2, '2026-08-25', peers).cards.length, 0);      // 标题对不上的那单不算
  const st = I.status({ chat: I.chatForOrder(a, '1', 2, '2026-08-20', peers) }, want);
  assert.equal(st.key, 'card');
  assert.equal(st.label, '卖家发来开票申请入口');
  // 两单标题都不像：都标「请核对」
  const vague = [{ no: '1', time: '2026-08-20', titles: ['虚构 万用表'] }, { no: '2', time: '2026-08-25', titles: ['虚构 电烙铁'] }];
  assert.equal(I.chatForOrder(a, '1', 2, '2026-08-20', vague).cards[0].shared, true);
  assert.equal(I.status({ chat: I.chatForOrder(a, '1', 2, '2026-08-20', vague) }, want).shared, true);
  // 卡片比下单还早：不是这单的
  assert.equal(I.chatForOrder(a, '3', 1, '2026-09-10', [{ no: '3', time: '2026-09-10', titles: ['虚构 不锈钢镊子'] }]).cards.length, 0);
  assert.equal(I.status({ chat: I.chatForOrder(a, '1', 2, '2026-08-20', peers), cardApplied: Date.now() }, want).key, 'applying');
  assert.ok(I.titleScore('虚构 不锈钢镊子 防静电…', '虚构不锈钢镊子防静电尖头ESD-15') >= 0.8);
}
// 订单详情页上「退款完成」「已退款」也认（「退货退款成功」本身就含「退款成功」）
assert.equal(I.detailRefund('某商品 退货退款成功 ￥12.25 x1 实付款 ￥12.25').refunded, true);
assert.equal(I.detailRefund('某商品 退款完成 ￥12.25 x1').refunded, true);
// manifest：天猫店的订单详情会被重定向到 trade.tmall.com，详情页脚本也要在那里运行；开票申请页、旺旺页里记新窗口地址的脚本
{
  const mf = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const scriptsFor = url => mf.content_scripts.filter(c => c.matches.some(m => new RegExp('^' + m.replace(/[.?+^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url))).flatMap(c => c.js);
  assert.ok(scriptsFor('https://trade.tmall.com/detail/orderDetail.htm?biz_order_id=5190000000000000101&forward_action=').includes('extension/detail.js'));
  assert.ok(scriptsFor('https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=5190000000000000101').includes('extension/detail.js'));
  assert.ok(scriptsFor('https://invoice-ua.taobao.com/e-invoice/invoice-apply-online.html?disableNav=YES%2CYES&orderId=1&channel=card').includes('extension/apply-card.js'));
  assert.ok(scriptsFor('https://invoice-ua.taobao.com/e-invoice/invoice-detail-tm.html?disableNav=YES&orderId=1').includes('extension/apply-card.js'));
  assert.ok(scriptsFor('https://market.m.taobao.com/app/im/chat-core/index.html').includes('extension/chat-main.js'));
  assert.equal(mf.version, '0.17.0');
  // 备份文件里写的插件版本：网页版读不到 manifest，用 app.js 里写死的版本号，两处要一致
  const appJs = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.equal((/const VERSION = EXT \? chrome\.runtime\.getManifest\(\)\.version : '([\d.]+)'/.exec(appJs) || [])[1], mf.version);
  // README 徽章上的版本号也一致
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('%E7%89%88%E6%9C%AC-' + mf.version + '-') && readme.includes('alt="版本 ' + mf.version + '"'));
  // 「← 订单分拣」回主页按钮：插件内容脚本运行的每个淘宝页面都有
  for (const u of ['https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', 'https://i.taobao.com/my_itaobao/invoice',
    'https://i.taobao.com/my_itaobao/pricelist/batchInvoice', 'https://market.m.taobao.com/app/im/chat/index.html',
    'https://invoice-ua.taobao.com/e-invoice/invoice-apply-online.html?orderId=1', 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=1',
    'https://trade.tmall.com/detail/orderDetail.htm?biz_order_id=1', 'https://ai.alimebot.taobao.com/intl/index.htm'])
    assert.ok(scriptsFor(u).includes('extension/home.js'), u);
  // 措辞（用户 2026-10-08）：界面上说「刷新发票情况」，不说「同步」（「同步带」「同步轮」是 classify.js 里的商品词，不在界面上）
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!html.includes('同步'), '主页 HTML 里还有「同步」');
  for (const f of ['../js/app.js', '../extension/invoice-list.js', '../extension/chat.js', '../extension/vip.js'])
    assert.deepEqual(fs.readFileSync(new URL(f, import.meta.url), 'utf8').match(/'[^'\n]*同步[^'\n]*'/g) || [], [], f + ' 的界面文字里还有「同步」');
  assert.ok(html.includes('每天自动刷新发票情况') && appJs.includes("'上次刷新 '"));
  // 调试日志不进备份：恢复时丢掉，备份时也去掉
  assert.ok(/const BACKUP_SKIP = \[[^\]]*'autoLog'/.test(appJs) && appJs.includes('delete b.storage.autoLog'));
}
// 「催卖家」的跟进话术：一句简短的催促；首次索要的模板不变
{
  const v = { title: '某大学', taxId: '121000009999999996' };
  assert.equal(I.renderMsg(I.FOLLOW_TEMPLATE, Object.assign({ orders: [{ no: '5190000000000000201', date: '2026-08-14', amount: 27 }] }, v)),
    '您好，订单 5190000000000000201（26.8.14，¥27）的发票麻烦尽快开一下，抬头 某大学，税号 121000009999999996，开好直接发 PDF 到这个窗口，谢谢！');
  assert.ok(I.DEFAULT_TEMPLATE.startsWith('您好，订单 {订单号}（{日期}，¥{金额}）需要开电子普通发票：抬头 {抬头}，税号 {税号}，邮箱 {邮箱}，内容按商品明细。'));
}
// 发票状态带上要列出的文件名（主页逐个单行显示，不从名字中间折断）
assert.deepEqual(I.status({ got: [{ file: 'a_1.pdf' }, { file: 'b_2.pdf' }] }, {}).files, ['a_1.pdf', 'b_2.pdf']);
assert.deepEqual(I.status({ have: { file: '第一批/001_x.pdf' } }, {}).files, ['第一批/001_x.pdf']);
assert.deepEqual(I.status({ chat: { files: [{ name: '发票.pdf' }], cards: [], images: [], email: [], asks: [] } }, {}).files, ['发票.pdf']);
console.log('自检通过：读表（xml:space）、合并规则、日期格式、先抓后导表、关键词建议、发票逻辑、已整理发票去重、读发票 PDF 文字、补差价待定、同店默认实验室、下载发票按金额日期对单、给卖家的消息、详情页退款、zip 打包、开票卡片、manifest 匹配与版本号、回主页按钮、措辞、调试日志不进备份、催卖家话术、发票状态的文件名');
