#!/usr/bin/env python3
"""给已经整理好的发票文件夹做索引，导入分拣主页后，已有的发票就不会重复下载、也不会再去找卖家要。

用法：python3 tools/index-invoices.py 发票文件夹 [更多文件夹...] > 已整理发票索引.json
      然后在主页「发票」栏点「导入已整理的发票索引」选这个文件。

只读：只读取 PDF 里的文字（发票号码、开票日期、价税合计、销售方），不改动、不移动任何文件。
需要 poppler 的 pdftotext，或 Python 的 pypdf（pip install pypdf），有一个就行。
有的发票价税合计最后几位 pdftotext / pypdf 读不出（2026-09 实测少数几张），这类会跳过；
插件主页「导入已整理的发票文件夹」用 PDF.js 读，能读全，优先用插件。
"""
import json, os, re, shutil, subprocess, sys


def pdf_text(path):
    if shutil.which('pdftotext'):
        return subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True, timeout=30).stdout
    from pypdf import PdfReader
    return '\n'.join(p.extract_text() or '' for p in PdfReader(path).pages)


def parse(t):
    # 有的 PDF 抽出来字和字之间夹着空格（「发 票 号 码 ：」），关键词里每个字之间都允许有空白
    no = re.search(r'发\s*票\s*号\s*码\s*[:：]?\s*(\d{8,20})', t)
    dt = re.search(r'开\s*票\s*日\s*期\s*[:：]?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日', t)
    amt = re.search(r'[（(]\s*小\s*写\s*[)）]\s*[¥￥]?\s*([\d,]+\.\d{2})', t)
    sel = re.search(r'销\s*名\s*称\s*[:：]\s*(\S+)', t)
    return {'invNo': no.group(1) if no else '',
            'date': f'{dt.group(1)}-{int(dt.group(2)):02d}-{int(dt.group(3)):02d}' if dt else '',
            'amount': float(amt.group(1).replace(',', '')) if amt else None,
            'seller': sel.group(1) if sel else ''}


def main(dirs):
    seen, out = set(), []
    for root in dirs:
        for d, _, files in os.walk(root):
            for f in sorted(files):
                if not f.lower().endswith('.pdf'):
                    continue
                p = os.path.join(d, f)
                try:
                    x = parse(pdf_text(p))
                except Exception as e:                      # 扫描件、加密的 PDF 读不出字：记下来，别整个停掉
                    print(f'读不了 {p}: {e}', file=sys.stderr)
                    continue
                if not x['invNo'] or x['amount'] is None:
                    print(f'不像发票，跳过 {p}', file=sys.stderr)
                    continue
                if x['invNo'] in seen:                     # 同一张发票在几个文件夹里都有
                    continue
                seen.add(x['invNo'])
                out.append(dict(x, file=os.path.relpath(p, root)))
    json.dump({'format': 'order-triage-invoice-index', 'version': 1, 'invoices': out}, sys.stdout, ensure_ascii=False, indent=1)
    print(f'共 {len(out)} 张发票', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
