# 订单分拣 —— 给 Claude 的项目说明

把个人淘宝账号里混在一起的订单分成「实验室用品 / 个人用品」，给科研报销整理清单。
作者打算之后开源到 GitHub，让别人也能用，所以代码和文档都要通用，不能写死作者的数据。

**开始工作前，如果存在 `local-data/HANDOFF.md`，先完整读一遍** —— 里面是最新进度和用户的具体要求。

项目位置：WSL `~/260923_taobao-order-triage`（Windows 下从 `\\wsl.localhost\<发行版>\home\<用户名>\…` 访问）。
WSL 里有 python3 3.12、node 18、git；在 WSL 里用 `python3`，不要用 `python`。

## 硬性约束（用户明确要求过，不要改变）

- **纯本地**：没有服务器、没有账号、没有任何上传/同步/统计功能；页面底部小字写明这一点，保留它。
  可选 AI 功能已在 2026-10-04 按用户要求删掉：整套流程都是写死的规则，不需要 AI。
- **零依赖**：不加载外部脚本、字体、CDN；除了商品图片（alicdn），页面不发出网络请求。开源库原样放在 vendor/（jsQR 读二维码、PDF.js 读发票 PDF），见 vendor/README.md
- **只做电脑版**：不需要做、也不需要维护手机适配
- **订单从淘宝订单页读取，订单表可选**（用户 2026-10-07 改：新人大多没用过淘宝网页版，卡在「导出订单表」）：
  第 1 步「从淘宝读取订单」——对话框只问「上次报销到哪天」（存 S.since，只读之后的订单、之前的不再判断），主页写 readJob={at,from}（30 分钟有效）并开「已买到的宝贝」干活页，extension/taobao.js 向后台领活后
  不用点按钮就自动翻页（scraper 的 want={all:true,from}），订单、图片、逐件退款一次读完；读完后台写 readResult、关页、切回主页。
  S.readFrom（读过的最早一天）及以后的订单按订单页建单（source: 'scrape'）。导入订单表（「更多」里，可选）只合并：
  表里有的单以订单表为准（mergeExport），表里没有的按订单页建的单保留，只去掉示例订单。
  旧的「订单表之前的订单」（want.older / S.older）只剩网页版补图窗口在用
- **能区分退款**：导出表里的「交易成功」不代表没退款（部分退款看不出来），退款要靠抓取的逐件文字或手动标记
- **界面设计准则**（用户 2026-10-07 定，改界面前先对照）：① 一条主线，同一件事只有一个入口、一步里不给几条路选，可选功能才进「更多」；
  ② 傻瓜使用，新人只看插件就能做完；③ 能自动化的都自动化；④ 不写大段说明（每步一行 ≤ 30 字，细节放 title）；
  ⑤ 用颜色和标签区分状态；⑥ 只切换视图、滚动页面的按钮一律不要。
  主线四步：读取订单 → 核对商品 → 处理发票 → 整理报销文件，每步一个主按钮；「更多」只有：导入已整理的发票文件夹、导入订单表、备份数据、从备份恢复
- **对外操作要用户确认**：提交开票申请、给卖家发消息这类会改变淘宝上状态的动作，先列清单、用户点确认才执行
  （「自动处理发票」把要平台申请 / 按入口申请 / 向卖家索要 / 请客服督促的合成一张分组清单，只确认一次）；
  Claude 自己不能在用户账号上点这类按钮（自动安全检查会拦，也不许绕过），真实账号上的这类测试由用户点
- **判不清的交给用户**：宁可放进「待定」，也不要把实验室物品判成个人（反过来也一样）
- **绝不改动其他目录**：用户的正式报销材料放在项目以外的目录里，
  由另一个会话负责。这个项目只用 `local-data/` 里的副本，需要新数据时请用户自己放进来
- **默认词表不能暴露作者**：个人词表只放通用日常类别；私密的（情趣、成人用品、内衣类）和太具体、像作者真买过的东西（如录音笔、门禁卡）不放。
  给子任务描述页面结构时，也不要拿用户页面上的真实标题/规格当例子（2026-09-28 曾因此把两条真实规格带进了模拟页）
- **抬头税号默认留空**：由用户在「设置 → 发票信息」里自己填（js/invoice.js 的 DEFAULT_TITLE / DEFAULT_TAX 是空的），代码、测试里不要写任何真实单位的抬头税号
- **私人数据不进仓库**：`local-data/`、所有 xlsx/csv、导出的 JSON 都被 `.gitignore` 忽略。用户订单里有很私密的个人物品，
  不要把真实订单内容写进代码、测试样例、README、提交信息，也不要发布到任何在线页面（包括 Artifact）

## 结构

```
manifest.json              Chrome 扩展说明（MV3）。项目根目录本身就是扩展：「加载已解压的扩展程序」选根目录
extension/background.js    点扩展图标切到已开着的主页（focusHome，没有才新开）；下载改名记 dlDone（带 attach 的附件下载记 attDone）；派活开的标签页编号记在 session 存储（jobTabs、workTabs）；
                           旺旺页只留一个（顶掉正在干活的旧页时写 chatLost）；每天自动处理：主页开着发 autoRun（不刷新主页），主页正忙（homeBusy）就跳过
extension/taobao.js        淘宝订单页的内容脚本：只在有有效的 readJob 且向后台领到活时自动全部读取（进度 readProgress、结束 readDone），
                           结果写回 chrome.storage.local 的 scraped；用户自己打开订单页时什么都不做（不出面板）
extension/invoice-list.js  「全部发票」页（i.taobao.com/my_itaobao/invoice）：同步三个标签的开票记录 → invSync；按 dlJobs 点「下载到本地」
extension/chat.js          旺旺网页版（market.m.taobao.com/app/im，内容在 iframe chat-core）：扫描卖家回复 → chatScan（开票卡片单独记 cards，不算图片；
                           没读成的会话记 failed，读不出消息时不覆盖上次结果）；自动发送只在主页心跳 askBeat 编号对得上时做，等用户最多 3 分钟；
                           按 dlJobs 点「下载文件」；按 cardRun 点开票卡片的「去申请」
extension/chat-main.js     旺旺页自身环境（world MAIN）：包一层 window.open，记下页面要新开的开票申请页地址（被弹窗拦截时由后台打开）
extension/apply-card.js    淘宝「开具发票」/「发票详情」页（invoice-ua.taobao.com/e-invoice/…）：按 cardJobs 核对订单号、抬头后提交，结果写 cardResult / cardApplied；
                           60 秒内点的是别的单的卡片（cardRun.no 不同）时不提交
extension/batch.js         「批量开票」页（i.taobao.com/my_itaobao/pricelist/batchInvoice）：按 applyJob 筛日期、勾单、核对抬头税号，停在「批量开票确认」，
                           由用户点「确认提交」；结果写 applyResult（一单都认不出时按出错处理）
extension/batch-main.js    批量开票页自身环境（world MAIN）：替 batch.js 发日期框要的回车
extension/vip.js           淘宝官方客服（ai.alimebot.taobao.com）：按 vipJob 转人工后逐单督促，之后回「OK」、点「提交投诉」
extension/qr.js            税务局电子发票页（*.chinatax.gov.cn，卖家发的二维码）：核对购买方、税号、价税合计（应报金额，少 1 元以内放行）后下载 PDF；没通过写 qrFail
extension/detail.js        订单详情页（trade.taobao.com/trade/detail、天猫重定向后的 trade.tmall.com/detail）：读卖家旺旺名、逐件退款、支付宝交易号和付款时间；
                           按主页发的 otShot 逐段滚动（第二段起藏起固定栏），截图由主页 captureVisibleTab 截、拼接（manifest 的 <all_urls> 只为这个）
extension/panel.js         各淘宝页脚本共用：右下角面板（otPanel）、领主页排的活（otTakeJob：invJobs + invClaim_*）、otLog 写本机调试日志、
                           otFail 干活没办成时写 jobFail（主页正等这一段就立即结束、红条写原因）并把本页切到前台（不用 alert）
extension/home.js          插件运行的每个淘宝页面上的小按钮「← 订单分拣」（一般在右上角，旺旺页在左下角）：发 goHome，后台切回 / 新开主页
js/invoice.js              发票纯逻辑：税号校验、发票文件名、聊天分析（docs = 卖家发来的表格 / Word）、每单状态、下载文件名、
                           从 PDF 文字认发票（parseInvoiceText，含发票明细 items、销售方 seller）
js/reimburse.js            报销规范（单位《报销规范手册》，用户 2026-10-09）纯逻辑：低值品判断（单价 > 200、无「模块」、设备词表 / 耗材词表，
                           判断顺序写在注释里）、要补的材料（超过 1000 元、与科研无关的字样、3D 打印）、到账差额组合、历史批次文件夹名、报销文件夹名
js/office.js               零依赖生成最小 xlsx（inlineStr）和 docx（内嵌图片），用 js/zip.js 打包
extension/invoice-main.js  跑在「全部发票」页自身环境（world MAIN）：扩展下载期间截下「下载到本地」造的阿里云发票链接
vendor/                    原样拷贝的开源库：jsQR（二维码）、PDF.js（读发票 PDF），版本见 vendor/README.md
index.html                 页面（样式内联；扩展页不允许内联脚本，别加 <script> 内联代码）
js/xlsx-lite.js            零依赖 xlsx/csv 读取（DecompressionStream 解 zip，正则读 sheet XML）
js/normalize.js            列名别名 → 统一订单结构；一单多件续行合并；抓取数据按订单号合并；退款判断
js/classify.js             关键词打分 + 同店铺/同商品记忆；classifyAll 两遍扫描（补邮费链接跟随店铺）；suggest 根据手动判断推荐增删词
js/app.js                  界面、状态（localStorage）、读取订单、导入订单表、键盘操作。界面是一条线的 4 步（flowSteps：每步 title / hint / acts，
                           选中的步骤决定下方显示商品列表还是发票表）；核对商品一张列表（visibleRows 待定排最前），「确认核对完成」= confirmSort；
                           处理发票一个按钮 runInvoice：九段依次做（stage：读订单详情 → 刷新开票记录 → 读旺旺回复 → 下载并核对 PDF → confirmGroups 一次确认
                           （插件做不了的「需处理」单也列出）→ doAsk / runCards / doVip / doApply），每段有超时、超时或出错写明原因接着下一段，
                           进度（第几段、等什么、已等多久）和结束时的逐段总结在步骤条下方（statusBar）；每段写进 autoLog（alog，后台排队追加，最多 300 条，不进备份）；
                           发票表「操作」列按状态一个主要操作（rowAction / rowAct：下载、催卖家、找客服督促、索要发票、申请开票、按入口申请、换开发票、联系卖家）；
                           window.__otDev 只给离线测试单独触发其中一段、逐单操作或改短时限（tmo）；读取进度也在步骤条下方，
                           没有订单时显示「开始使用」卡片（renderGuide），顶上进度条（renderDash，只显示不能点），
                           应报金额只有一个来源 dueOf（实付 − 退款，和 derive 共用 lineDue）；下载的票核对不通过是红色 badinv（不算已取得），
                           旺旺会话没读成是 chatfail（不退回「需向卖家索要」）；整理报销后订单记进 S.packed（以后算「已整理（第 N 批）」），
                           整理报销文件按手册结构输出（packPlan / makePack：不超过1k耗材 / 超过1k耗材 / 低值品、README.txt、报销清单.xlsx、用途说明 docx），
                           每次记一个批次 S.batches（第 4 步说明区下方「报销记录」、填到账、差额组合）；低值品标签 lowPill（S.lowval 按标题记住）；
                           附件（订单页面截图、手动添加的）存 IndexedDB orderTriage-att（不进备份，清除本机数据时清掉），旺旺下载的附件记在 attDone，
                           不常用的收在顶栏「更多」；不提供导出（「备份数据」除外）、不提供改词表（用户 2026-10-05 要求去掉多余的自由度）
js/sample.js               虚构示例数据（给没有数据的人试用；「示例-」开头的订单只看界面，第 3、4 步主按钮置灰，不去淘宝页处理）
js/zip.js                  零依赖 zip 打包（整理报销文件的压缩包；中文文件名带 UTF-8 标记）
scraper/taobao-scraper.js  在淘宝「已买到的宝贝」页控制台运行：按文字特征定位订单块，抓图片/逐件退款，可自动翻页，存本地 JSON
tools/eval.mjs             node 评估分类效果：node tools/eval.mjs [订单表] [labels.json]
tools/selftest.mjs         自检（虚构数据）：合并只补图片/退款/链接、不新增订单；关键词建议
tools/mock-taobao.html     模拟订单页（数据虚构）：无参数 = 旧版结构（测回退解析）；?v=new = 2026-09 真实新版结构
tools/e2e-mock.py          离线端到端测试：主页「从淘宝读取订单」（真实网址的请求回应模拟页）→ 自动翻页、关页、结果；界面准则检查（四步、
                           每步至多一个主按钮、没有只滚动的按钮、「更多」四项）；导入订单表合并；新旧版模拟页逐单核对（不联网）；
                           认不出「下一页」、没读出商品的订单不算删进回收站；「开始使用」卡片的读取进度颜色
tools/e2e-invoice.py       离线：刷新开票记录、旺旺扫描（含「安全提醒」系统卡片）、下载改名（含本机假阿里云 https）、自动处理发票分段进度和只确认一次、
                           autoLog、操作列（催卖家只填不发、单单找客服督促）、图例不裁字、回主页按钮；自动发送不带用户自己打的字、残留队列不接管；
                           每天自动处理不打断；[17] 下载的票核对（合开、挪单、不是发票、少 1 元以上、券前价、部分退款）和整理后记为已整理、读旺旺失败不退回索要
tools/e2e-extras.py        离线：选文件夹读发票 PDF、二维码、备份恢复（autoLog 不进备份；清除本机数据前自动备份）、自动处理发票某段超时 + 只有一单需处理；
                           出错提示不自动消失、发票表为空写明原因、两个主页不互相覆盖、示例数据不处理发票
tools/e2e-reimburse.py     离线：报销规范——低值品标签与切换、没填姓名先开设置、超过 1000 元自动截订单页面（模拟详情页分段拼接）、3D 打印订单的消息末尾追加一句、
                           缺材料标签与「手动添加发票 / 附件」、整理结构（README.txt、报销清单.xlsx、用途说明 docx 用 openpyxl / python-docx 读回）、
                           报销记录（填到账、差额组合）、导入文件夹认出历史批次、批次进备份
tools/e2e-apply.py         离线：平台批量申请（批量开票页改版认不出订单时不记「平台开不了」）、按卖家的开票入口申请（mock-invoice-apply.html；
                           点 A 的卡片打开 B 的申请页时不提交）、干活页用完关掉
tools/make-release.sh      打发布包 dist/order-triage-v<版本>.zip（见「发布」）
tools/index-invoices.py    （可选）用 pdftotext/pypdf 给发票文件夹做索引；插件里已能直接选文件夹读，这个留给命令行用
tools/fixtures/            测试用的虚构二维码图、商品图
tools/screenshots.py       生成 README 图片：横幅（tools/readme-banner.html 渲染）→ docs/assets/，截图和演示动图 → docs/screenshots/；
                           示例数据 + 虚构开票记录（抬头「示例大学」），全新临时浏览器配置、不联网；动图里的指针、按键提示、说明文字是录制时临时叠加的
docs/assets/               README 横幅、功能图标、状态色块（图标和色块是手写的 SVG）
```

浏览器和 Node 共用同一份 js 模块（文件末尾按 `module.exports` / 全局变量两种方式导出）。

## 测试

- 页面：`.claude/launch.json` 里的 `triage` 起本地服务（端口 8765），打开
  `http://localhost:8765/index.html?load=local-data/订单数据.xlsx` 直接载入本地数据（只允许同源相对路径）
- 抓取脚本：打开 `tools/mock-taobao.html`，在页面里 `fetch('/scraper/taobao-scraper.js')` 后 `eval`，再调 `orderTriage.grab()` / `.auto()`
- 分类：`node tools/eval.mjs`；自检：`node tools/selftest.mjs`
- 改抓取脚本 / 扩展后必跑：`node tools/selftest.mjs`，`env -u TMPDIR python3 tools/e2e-mock.py`、`tools/e2e-invoice.py`、`tools/e2e-extras.py`、`tools/e2e-apply.py`、`tools/e2e-reimburse.py`
  （e2e-invoice 约 10 分钟，其余各几分钟；TMPDIR 太长 Chromium 会报 Socket path too long）。改开票申请（batch.js、apply-card.js、卡片）时 e2e-apply 一定要跑。
  注意 WSL 里默认 python3 是系统的、没装 playwright，用装了 playwright 的那个 python3（比如 conda 里的）
- Playwright 连着真实测试浏览器时会截走下载（存到 /tmp/playwright-artifacts-*，断开就没了）：测下载前先 Browser.setDownloadBehavior default，下载期间别连
- 真实页面结构写在 `scraper/taobao-scraper.js` 的 parseBox 注释里；淘宝改版时先在真实页面核对，再同步改 mock 的 ?v=new
- 读取链路有两条：扩展版（主页写 readJob，淘宝页内容脚本领活、抓完写 scraped，主页监听后合并）；
  网页版（「补充图片 → 复制抓取脚本」生成 `(orderTriageScraper 源码)({nos, from})`，index.html 用 `<script data-no-run>` 只取函数不运行）
- 扩展测试：Playwright 的 Chromium 用 `launch_persistent_context(channel='chromium', args=['--load-extension=项目根目录'])`；
  manifest 里匹配了 `127.0.0.1/tools/mock-taobao.html`；有 readJob 时模拟页会自动开始读取
- README 图片：界面改动较大时 `env -u TMPDIR python3 tools/screenshots.py` 重新生成（要 Pillow；可只生成一类：`banner` / `shots` / `gifs`），
  生成后逐张看图、动图抽帧看，确认没有真实订单、店铺、抬头税号；按钮名、状态名改了要同步改 README 和脚本里的说明文字
- 测完清掉测试浏览器里的 `localStorage`（键名 `orderTriage.app.v1`、`orderTriage.scraped.v1`），不要把用户数据留在浏览器里
- 操作用户真实的淘宝页面（Claude in Chrome）前必须先征得用户同意；遇到滑块/验证码停下让用户自己处理，不要尝试绕过

## 界面约定（用户 2026-10-05）

- 界面文字一律中文、正式、简洁，不用「你」「帮你」这类口语；每个按钮和可点元素都有 title 悬停说明
- 发票状态的名称在 js/invoice.js 的 LABEL；颜色七种（app.js TONE + index.html 的 --*-ink/--*-bg），进度区小圆点和 .inv-legend 图例用实心色块 --*-sw；
  灰色「无需开票」在发票栏不出现，图例里没有它
- 备份 / 恢复在顶栏「更多」（app.js backupData / restoreData，文件格式见那里的注释）；恢复时丢掉的临时键列在 BACKUP_SKIP，新增「进行中的任务」类存储键时要加进去；
  本机调试日志 autoLog 备份时也去掉；报销批次（S.batches）要进备份，IndexedDB 里的截图和附件不进备份
- 报销材料标签（发票表、整理预览）：低值品深色 --low-*、待确认黄色（--uns）、缺材料橙色 --mat-*；整理报销文件的结构和关键词表以单位《报销规范手册》第三章为准
- 面向用户的措辞：说「刷新发票情况」，不说「同步」（用户 2026-10-08；selftest 会查）；顶栏有「打开淘宝」（登录用）
- 插件开的干活页按 tab.id 记在 background.js 的 workTabs，做完由页面发 closeMe 关掉；用户自己点开的页面不关；旺旺页只复用一个
- 发给卖家的消息模板（js/invoice.js DEFAULT_TEMPLATE、催卖家用的 FOLLOW_TEMPLATE）、extension/vip.js 里发给客服的话术是用户定的，不要改

## 代码风格

中文界面文案和注释；注释说「为什么」而不是「做了什么」。改动保持和周围代码一致的密度与写法。

## 发布

`bash tools/make-release.sh` 生成 `dist/order-triage-v<版本>.zip`（dist/ 不进仓库），用 `gh release create v<版本> <zip>` 上传到 GitHub Releases。README 的安装步骤指向 Releases 最新版。压缩包用 Python zipfile 打包，中文文件名才带 UTF-8 标记。
