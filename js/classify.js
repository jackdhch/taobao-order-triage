/*
 * classify —— 把每件商品判成 实验室(lab) / 个人(personal) / 待定(unsure)
 *
 * 纯本地的关键词打分，每个判断都给出命中的词，方便人工复核。判不清的一律进「待定」，
 * 由用户拍板；用户的手动判断会形成两种记忆：
 *   - 同店铺记忆：某店铺被手动判过 2 次以上且方向一致，同店铺其余商品跟随
 *   - 同标题记忆：同一个商品标题（再买一单）直接沿用上次判断
 *
 * 词表是通用的「科研/工程采购 vs 个人生活」，可以在页面「设置」里改，也可以直接改这里。
 */
(function (root) {
  'use strict';

  // 权重 2 = 基本能定性；1 = 倾向
  const DEFAULT_RULES = {
    lab: {
      2: ['航模', '穿越机', 'FPV', '无人机', '飞控', '电调', '舵机', '螺旋桨', '桨叶', '无刷', '电机', '锂电池', 'LiPo',
          'XT60', 'XT30', 'XT90', 'MR30', 'AS150', '航空插头', '连接器', '端子', '杜邦', 'GH1.25', 'SH1.0', 'JST',
          '屏蔽线', 'rvvp', 'RVVP', '硅胶线', '电子线', '热缩管', '焊锡', '锡线', '焊台', '电烙铁', '万用表', '示波器',
          '降压模块', '稳压', '开关电源', '接收机', 'ELRS', '遥控器', 'GPS模块', '罗盘', '传感器', '开发板', '单片机',
          'STM32', 'ESP32', 'Arduino', '树莓派', '碳纤维', '碳板', '玻纤', '环氧', '3D打印', 'CNC', '铝型材', '轴承',
          '螺丝', '螺钉', '螺母', '铆钉', '垫片', '铜柱', '铝柱', '内六角', '扳手', '螺丝刀', '批头', '剥线钳', '卡尺',
          '台钳', '虎钳', '锉刀', '工具箱', '工具车', '防护箱', '接线盒', '三防漆', '704', '硅橡胶', '导热', '陶瓷片',
          '散热片', '乐泰', 'LOCTITE', 'Loctite', '卡夫特', '螺纹胶', '绝缘胶带', '电工胶带', '零件盒', '零件箱',
          '劳保手套', '丁腈手套', '电子元器件', '分电板', '机器人', '模型配件', 'XPS', '标签机', '色带', 'WD-40', 'wd40',
          'WD40', '除锈', '平衡头', '调参', '实验', '科研', '工业级', '航模配件', '钳', 'PLATO',
          // FPV / 飞控
          '图传', '数传', '天空端', '地面站', '机架', '飞塔', '桨保', '平衡充', '航模电池', '电池绑带', 'BEC', 'TBS',
          'Crossfire', 'Betaflight', 'INAV', 'ArduPilot', 'Pixhawk', 'PX4', 'MAVLink', 'Walksnail', 'HDZero', '云台',
          '天线', 'IPEX', 'SMA头', 'SMA转', '同轴线', '馈线', '分线器', '分线盒', '接线端子', '端子线', '信号线', '控制线',
          '护套线', '阻燃', '屏蔽', '束线带', '尼龙扎带', '缠绕管', '波纹管', '号码管', '线槽',
          // 电子
          'PCB', '洞洞板', '万用板', '面包板', '排针', '排母', '电阻', '电容', '电感', '二极管', '三极管', 'MOS管', '继电器',
          '光耦', '芯片', 'IMU', '陀螺仪', '气压计', '光流', '测距', '毫米波', '超声波', '激光雷达', '串口', 'USB转TTL',
          'CH340', 'RS485', 'RS232', 'CAN总线', '电源模块', '助焊', '松香', '吸锡', '洗板水', '热风枪', '焊锡丝', '焊接',
          // 五金 / 结构 / 材料
          '螺栓', '杯头', '沉头', '圆柱头', '平垫', '弹垫', '防松', '尼龙柱', '攻丝', '丝锥', '钻头', '台钻', '砂纸', '打磨',
          '热熔胶', 'AB胶', '502胶', '固化剂', '碳纤维布', '玻纤布', '碳管', '碳棒', '滑轨', '同步带', '同步轮', '联轴器',
          '舵盘', '球头', '拉杆', '型材', '角码', '亚克力', 'PETG', 'PLA耗材', '打印耗材', '激光切割', 'KT板', 'EPO', 'EPP',
          '轻木', '桐木', '船模', '浮筒', '水翼', '劳保', '丁腈', '防割'],
      1: ['胶水', '胶带', '扎带', '收纳盒', '收纳箱', '注射器', '针筒', '泡沫', '喷漆', '延长线', '读卡器', '工具',
          '五金', '不锈钢', '铝合金', '模块', '电源', '充电器', '插头', '防水', '电线', '电缆', '套管', '测试',
          '工业', '机械', 'DIY', '耐高温', '转接线', '线材', '国标', '铝板', '钢板', '钣金'],
    },
    // 个人这边只放通用的日常类别；私密的、太具体（像某个人真买过的东西）的词不放进默认词表，要用就在「设置」里自己加，只存本机
    personal: {
      2: ['手机壳', '保护壳', '钢化膜', '手机膜', 'T恤', '短袖', '长袖', '上衣', '衬衫', '外套', '卫衣', '裤', '裙',
          '拖鞋', '运动鞋', '袜', '帽子', '美妆', '化妆', '口红', '面膜', '护肤',
          '精华', '防晒', '香水', '洗发', '沐浴', '牙膏', '牙刷', '洗面奶', '零食', '饮料', '咖啡', '茶叶',
          '奶粉', '可乐', '坚果', '水果', '猫粮', '狗粮', '宠物', '婴儿', '宝宝', '母婴',
          '健身', '厨具', '餐具', '浴室', '窗帘',
          '床单', '枕头', '被子', '手表', '耳机', '充电宝', '洗衣', '洗碗', '拖把', '衣架', '雨伞', '保温杯', '水杯', '玩偶', '毛绒', '首饰', '项链', '耳环', '戒指', '发圈',
          '发夹', '钱包', '行李箱', '化妆包', '眼霜', '唇膏', '美甲', '剃须', '牙线', '漱口水', '维生素', '保健品', '饼干',
          '巧克力', '牛奶', '酸奶', '方便面', '螺蛳粉', '大米', '食用油'],
      1: ['家居', '儿童', '礼盒', '女士', '男士', '夏季', '冬季', '眼镜', '运动', '游戏', '电竞',
          '玩具', '厨房', '卧室', '纸巾', '抽纸'],
    },
    // 命中这些词且两边分差不大时，强制进「待定」
    unsure: ['纸巾', '抽纸', '湿巾', '冰袋', '消毒', '酒精', '手套', '收纳', '剪刀', '数据线', '充电器', '转接头',
             'OTG', 'HDMI', '插座', '插线板', '延长线', '鼠标', '键盘', '灯', '电池', '胶带', '清洁', '气吹', '毛巾'],
  };

  function compile(rules) {
    const list = [];
    for (const side of ['lab', 'personal'])
      for (const w of [2, 1])
        for (const word of (rules[side] && rules[side][w]) || []) list.push({ side, w, word, lw: word.toLowerCase() });
    return { list, unsure: (rules.unsure || []).map(x => ({ word: x, lw: x.toLowerCase() })) };
  }

  function scoreText(text, compiled) {
    const t = String(text || '').toLowerCase();
    const hits = { lab: [], personal: [], unsure: [] };
    const score = { lab: 0, personal: 0 };
    for (const r of compiled.list) {
      if (t.includes(r.lw)) { score[r.side] += r.w; hits[r.side].push(r.word); }
    }
    for (const u of compiled.unsure) if (t.includes(u.lw)) hits.unsure.push(u.word);
    return { score, hits };
  }

  /*
   * ctx = { compiled, shopMemory: Map(shop -> {lab, personal}), titleMemory: Map(normTitle -> cat), norm }
   * 返回 { cat, via: 'title'|'shop'|'rule', hits, score, why }
   */
  // 补差价、补邮费、补拍这类链接本身看不出买的是什么：一律留给用户确认，不跟店铺、不跟同名商品（用户 2026-10-03 要求）
  const SURCHARGE_RE = /邮费|补拍|差价|补运费|运费补|补邮/;
  const isSurcharge = title => SURCHARGE_RE.test(title || '');

  function classify(line, order, ctx) {
    if (isSurcharge(line.title))
      return { cat: 'unsure', via: 'surcharge', hits: { lab: [], personal: [], unsure: [] }, score: null, why: '补差价 / 邮费链接，无法判断所购商品，需手动确认' };
    const nt = ctx.norm ? ctx.norm(line.title) : line.title;
    const tm = ctx.titleMemory && ctx.titleMemory.get(nt);
    if (tm) return { cat: tm, via: 'title', hits: { lab: [], personal: [], unsure: [] }, score: null, why: '同一商品已有判断' };

    const text = [line.title, line.sku, order.shop].join(' ');
    const { score, hits } = scoreText(text, ctx.compiled);

    const sm = ctx.shopMemory && ctx.shopMemory.get(order.shop);
    // 同一家店你手动判过实验室（且没判过个人）：这家店以后的东西默认实验室；全判个人的要 2 件以上才跟
    if (sm && sm.lab >= 1 && sm.personal === 0)
      return { cat: 'lab', via: 'shop', hits, score, why: '同店已判为实验室 ' + sm.lab + ' 件' };
    if (sm && sm.personal >= 2 && sm.lab === 0)
      return { cat: 'personal', via: 'shop', hits, score, why: '同店已判为个人 ' + sm.personal + ' 件' };

    let cat = 'unsure';
    if (score.lab >= 2 && score.lab >= score.personal * 2 + 1) cat = 'lab';
    else if (score.personal >= 2 && score.personal >= score.lab * 2 + 1) cat = 'personal';
    // 模糊词只在证据偏弱或两边都有迹象时才把结果打回「待定」
    if (cat !== 'unsure' && hits.unsure.length) {
      const other = cat === 'lab' ? 'personal' : 'lab';
      if (score[other] > 0 || score[cat] < 3) cat = 'unsure';
    }
    const why = cat === 'unsure'
      ? (score.lab + score.personal === 0 ? '未命中关键词'
         : hits.unsure.length && !(score.lab && score.personal) ? '含模糊词「' + hits.unsure[0] + '」，需手动判断'
         : '同时命中实验室与个人关键词，需手动判断')
      : '命中：' + hits[cat].slice(0, 4).join('、');
    return { cat, via: 'rule', hits, score, why };
  }

  function classifyAll(orders, ctx) {
    const out = new Map();
    for (const o of orders) for (const l of o.lines) out.set(l.id, classify(l, o, ctx));
    return out;
  }

  // 标题里的候选词：英文数字串（CH340、XT60）+ 中文 2~4 字片段。营销套话不当候选
  const STOP = /^(适用|官方|旗舰|专用|包邮|正品|新款|加厚|套装|高速|厂家|直销|现货|大号|小号|多功能|通用|耐用|加长|超级|优惠|优惠价|活动|活动价|限时|特价|家用|小型|反复)$/;
  function grams(t) {
    const out = new Set();
    for (const m of String(t).matchAll(/[A-Za-z0-9][A-Za-z0-9.\-]*[A-Za-z0-9]/g))
      if (/[A-Za-z]/.test(m[0]) && m[0].length <= 16) out.add(m[0]);
    for (const seg of String(t).replace(/[^一-龥]+/g, ' ').split(' '))
      for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= seg.length; i++) { const g = seg.slice(i, i + n); if (!STOP.test(g)) out.add(g); }
    return out;
  }

  /*
   * 根据用户的手动判断推荐增删关键词。
   *   rows: [{ title, text, manual: 'lab'|'personal'|undefined, auto: 只看词表的判断 }]
   *   remove：某个词命中的已判商品里，判反的 ≥2 件且多于判对的 —— 这个词在误导
   *   add：用户判成某类、词表却没认出来的商品里，挑能覆盖最多件、且从没出现在另一类已判商品里的片段
   * ponytail: 中文不分词，候选会有「头螺」这类跨词片段，所以只推荐、由用户点采纳；要更准再换分词
   */
  // 覆盖件数相同时：型号（CH340）比中文片段准；中文取短的，少带跨词的尾巴
  const better = (a, b) => /[A-Za-z]/.test(a) !== /[A-Za-z]/.test(b) ? /[A-Za-z]/.test(a) : a.length < b.length;
  function suggest(rows, rules, maxAdd) {
    const compiled = compile(rules);
    const judged = rows.filter(x => x.manual === 'lab' || x.manual === 'personal')
      .map(x => Object.assign({ lt: String(x.text || x.title).toLowerCase() }, x));
    const remove = [];
    for (const r of compiled.list) {
      let right = 0, wrong = 0;
      for (const x of judged) if (x.lt.includes(r.lw)) { if (x.manual === r.side) right++; else wrong++; }
      if (wrong >= 2 && wrong > right) remove.push({ word: r.word, side: r.side, w: r.w, right, wrong });
    }
    const have = new Set(compiled.list.map(r => r.lw));
    // 模糊词（「清洁」「数据线」）是故意交给你判的，推荐它或它的一截当强词等于把模糊词表架空；
    // 取片段前先把它们从标题里挖掉，也免得推荐「数据线收纳」里跨词的「线收」
    const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cutVague = t => compiled.unsure.reduce((a, u) => a.replace(new RegExp(esc(u.word), 'gi'), ' '), String(t));
    const inVague = lg => compiled.unsure.some(u => u.lw.includes(lg));
    const add = [];
    for (const side of ['lab', 'personal']) {
      // 反例不只看手动判过的：个人用品大多是自动判的，很少有人去手动判，只看手动的会推荐「家用」「手机」这种两边都有的词
      const other = rows.filter(x => (x.manual || x.auto) && (x.manual || x.auto) !== side && (x.manual || x.auto) !== 'unsure')
        .map(x => x.lt ? x : Object.assign({ lt: String(x.text || x.title).toLowerCase() }, x));
      const missed = new Map();                      // 同一标题（再买一单）只算一件
      for (const x of judged) if (x.manual === side && x.auto !== side) missed.set(x.title, x);
      const cover = new Map();                       // 覆盖按「包含」算，和判断时一致（CH340 也算进 CH340G）
      for (const [title] of missed) for (const g of grams(cutVague(title))) {
        const lg = g.toLowerCase();
        if (have.has(lg) || cover.has(lg)) continue;
        const titles = new Set();
        for (const [t, x] of missed) if (x.lt.includes(lg)) titles.add(t);
        cover.set(lg, { word: g, titles });
      }
      const ok = [...cover].filter(([lg, c]) => c.titles.size >= 2 && !other.some(x => x.lt.includes(lg)) && !inVague(lg));
      const left = new Set(missed.keys());
      for (let k = 0; k < (maxAdd || 8); k++) {
        let best = null, bn = 0;
        for (const [, c] of ok) {
          let n = 0; for (const t of c.titles) if (left.has(t)) n++;
          if (n > bn || (n === bn && best && better(c.word, best.word))) { best = c; bn = n; }
        }
        if (!best || bn < 2) break;
        add.push({ word: best.word, side, n: bn, examples: [...best.titles].slice(0, 2) });
        for (const t of best.titles) left.delete(t);
      }
    }
    return { add, remove };
  }

  const api = { isSurcharge,  DEFAULT_RULES, compile, scoreText, classify, classifyAll, suggest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Classify = api;
})(typeof self !== 'undefined' ? self : this);
