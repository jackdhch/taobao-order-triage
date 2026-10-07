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
- **对外操作要用户确认**：提交开票申请、给卖家发消息这类会改变淘宝上状态的动作，每一批先列清单、用户点确认才执行；
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
extension/background.js    点扩展图标打开主页（chrome-extension://…/index.html）
extension/taobao.js        淘宝订单页的内容脚本：有有效的 readJob 且向后台领到活时自动全部读取（进度 readProgress、结束 readDone）；
                           否则读主页写的缺图清单 want 出「开始补图片」面板。结果写回 chrome.storage.local 的 scraped
extension/invoice-list.js  「全部发票」页（i.taobao.com/my_itaobao/invoice）：同步三个标签的开票记录 → invSync；按 dlJobs 点「下载到本地」
extension/chat.js          旺旺网页版（market.m.taobao.com/app/im，内容在 iframe chat-core）：扫描卖家回复 → chatScan（开票卡片单独记 cards，不算图片）；
                           按 dlJobs 点「下载文件」；按 cardRun 点开票卡片的「去申请」
extension/chat-main.js     旺旺页自身环境（world MAIN）：包一层 window.open，记下页面要新开的开票申请页地址（被弹窗拦截时由后台打开）
extension/apply-card.js    淘宝「开具发票」/「发票详情」页（invoice-ua.taobao.com/e-invoice/…）：按 cardJobs 核对订单号、抬头后提交，结果写 cardResult / cardApplied
extension/detail.js        订单详情页（trade.taobao.com/trade/detail、天猫重定向后的 trade.tmall.com/detail）：读卖家旺旺名、逐件退款
extension/panel.js         上面两个脚本共用的面板和「领主页排的活」（invJobs + invClaim_*）
js/invoice.js              发票纯逻辑：税号校验、发票文件名、聊天分析、每单状态、下载文件名、从 PDF 文字认发票（parseInvoiceText）
extension/invoice-main.js  跑在「全部发票」页自身环境（world MAIN）：扩展下载期间截下「下载到本地」造的阿里云发票链接
vendor/                    原样拷贝的开源库：jsQR（二维码）、PDF.js（读发票 PDF），版本见 vendor/README.md
index.html                 页面（样式内联；扩展页不允许内联脚本，别加 <script> 内联代码）
js/xlsx-lite.js            零依赖 xlsx/csv 读取（DecompressionStream 解 zip，正则读 sheet XML）
js/normalize.js            列名别名 → 统一订单结构；一单多件续行合并；抓取数据按订单号合并；退款判断
js/classify.js             关键词打分 + 同店铺/同商品记忆；classifyAll 两遍扫描（补邮费链接跟随店铺）；suggest 根据手动判断推荐增删词
js/app.js                  界面、状态（localStorage）、从淘宝读取订单、导入订单表、键盘操作。界面是一条线的 6 步（flowSteps，每步 help + how 分步说明，每步只有一个操作；用户 2026-10-07 要求主线不能有重复入口和分支，
                           「上次报销截止点」一步已删，「导入已整理的发票文件夹」「导入订单表」在「更多」里），读取进度 / 结果在步骤条下方（readBar），
                           没有订单时显示「开始使用」卡片（renderGuide），顶上进度条（renderDash），
                           不常用的收在顶栏「更多」；不提供导出（「备份数据」除外）、不提供改词表（用户 2026-10-05 要求去掉多余的自由度）
js/sample.js               虚构示例数据（给没有数据的人试用）
scraper/taobao-scraper.js  在淘宝「已买到的宝贝」页控制台运行：按文字特征定位订单块，抓图片/逐件退款，可自动翻页，存本地 JSON
tools/eval.mjs             node 评估分类效果：node tools/eval.mjs [订单表] [labels.json]
tools/selftest.mjs         自检（虚构数据）：合并只补图片/退款/链接、不新增订单；关键词建议
tools/mock-taobao.html     模拟订单页（数据虚构）：无参数 = 旧版结构（测回退解析）；?v=new = 2026-09 真实新版结构
tools/e2e-mock.py          离线端到端测试：主页「从淘宝读取订单」（真实网址的请求回应模拟页）→ 自动翻页、关页、结果；导入订单表合并；
                           导入虚构订单表 → 模拟页一键补图 → 逐单核对（不联网）
tools/e2e-invoice.py       离线：全部发票同步、旺旺扫描、下载改名（含本机假阿里云 https）
tools/e2e-extras.py        离线：选文件夹读发票 PDF、核对重复、二维码
tools/e2e-apply.py         离线：平台批量申请、按卖家的开票入口申请（mock-invoice-apply.html）、干活页用完关掉
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
- 改抓取脚本 / 扩展后必跑：`env -u TMPDIR python3 tools/e2e-mock.py`、`tools/e2e-invoice.py`、`tools/e2e-extras.py`（各约 1 分钟；TMPDIR 太长 Chromium 会报 Socket path too long）。
  注意 WSL 里默认 python3 是系统的、没装 playwright，用装了 playwright 的那个 python3（比如 conda 里的）
- Playwright 连着真实测试浏览器时会截走下载（存到 /tmp/playwright-artifacts-*，断开就没了）：测下载前先 Browser.setDownloadBehavior default，下载期间别连
- 真实页面结构写在 `scraper/taobao-scraper.js` 的 parseBox 注释里；淘宝改版时先在真实页面核对，再同步改 mock 的 ?v=new
- 补图链路有两条：扩展版（主页 persist 时把 want 写进 chrome.storage，淘宝页内容脚本抓完写 scraped，主页监听后合并）；
  网页版（「补图片 → 复制抓取脚本」生成 `(orderTriageScraper 源码)({nos, from})`，index.html 用 `<script data-no-run>` 只取函数不运行）
- 扩展测试：Playwright 的 Chromium 用 `launch_persistent_context(channel='chromium', args=['--load-extension=项目根目录'])`；
  manifest 里匹配了 `127.0.0.1/tools/mock-taobao.html`，模拟页会自动出面板
- README 图片：界面改动较大时 `env -u TMPDIR python3 tools/screenshots.py` 重新生成（要 Pillow；可只生成一类：`banner` / `shots` / `gifs`），
  生成后逐张看图、动图抽帧看，确认没有真实订单、店铺、抬头税号；按钮名、状态名改了要同步改 README 和脚本里的说明文字
- 测完清掉测试浏览器里的 `localStorage`（键名 `orderTriage.app.v1`、`orderTriage.scraped.v1`），不要把用户数据留在浏览器里
- 操作用户真实的淘宝页面（Claude in Chrome）前必须先征得用户同意；遇到滑块/验证码停下让用户自己处理，不要尝试绕过

## 界面约定（用户 2026-10-05）

- 界面文字一律中文、正式、简洁，不用「你」「帮你」这类口语；每个按钮和可点元素都有 title 悬停说明
- 发票状态的名称在 js/invoice.js 的 LABEL；颜色七种（app.js TONE + index.html 的 --*-ink/--*-bg），进度区小圆点和 .inv-legend 图例用实心色块 --*-sw；
  灰色「无需开票」在发票栏不出现，图例里没有它
- 备份 / 恢复在顶栏「更多」（app.js backupData / restoreData，文件格式见那里的注释）；恢复时丢掉的临时键列在 BACKUP_SKIP，新增「进行中的任务」类存储键时要加进去
- 插件开的干活页按 tab.id 记在 background.js 的 workTabs，做完由页面发 closeMe 关掉；用户自己点开的页面不关；旺旺页只复用一个
- 发给卖家的消息模板（js/invoice.js DEFAULT_TEMPLATE）、extension/vip.js 里发给客服的话术是用户定的，不要改

## 代码风格

中文界面文案和注释；注释说「为什么」而不是「做了什么」。改动保持和周围代码一致的密度与写法。

## 发布

`bash tools/make-release.sh` 生成 `dist/order-triage-v<版本>.zip`（dist/ 不进仓库），用 `gh release create v<版本> <zip>` 上传到 GitHub Releases。README 的安装步骤指向 Releases 最新版。压缩包用 Python zipfile 打包，中文文件名才带 UTF-8 标记。
