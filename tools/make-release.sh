#!/bin/bash
# 打包发布用的压缩包：只放插件运行需要的文件（不含测试、截图、开发说明、local-data）。
# 压缩包里文件直接在最外层：Windows「全部解压缩」会自动建一个同名文件夹，选它加载即可。
# 用法：bash tools/make-release.sh   → dist/order-triage-v<版本>.zip
set -e
cd "$(dirname "$0")/.."
V=$(python3 -c "import json; print(json.load(open('manifest.json', encoding='utf-8'))['version'])")
OUT=dist/order-triage-v$V.zip
rm -rf dist/stage && mkdir -p dist/stage
cp -r manifest.json index.html LICENSE js extension scraper vendor dist/stage/
cat > dist/stage/安装说明.txt <<TXT
订单分拣 v$V

1. 把这个压缩包解压到一个固定位置（例如「文档\订单分拣」），之后不要移动或删除这个文件夹。
2. 在 Chrome 地址栏输入 chrome://extensions 并回车，打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择解压出的文件夹（能直接看到 manifest.json 的那一层）。
4. 点击浏览器工具栏上的扩展图标（拼图图标里可以把它固定到工具栏），打开主页。
5. 先在「设置 → 发票信息」填写单位的发票抬头和税号。

完整说明：https://github.com/jackdhch/taobao-order-triage
更新到新版本前，请先在主页「更多 → 备份数据」备份一次。
TXT
find dist/stage -name '__pycache__' -prune -exec rm -rf {} +
rm -f "$OUT"
# 用 Python 打包：中文文件名会带上 UTF-8 标记，Windows 解压不会乱码（Info-ZIP 的 zip 在这里不带这个标记）
python3 - "$OUT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('dist/stage'):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, 'dist/stage'))
PY
rm -rf dist/stage
echo "$OUT $(du -k "$OUT" | cut -f1) KB"
