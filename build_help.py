#!/usr/bin/env python3
"""Build the help site, help/*.html, from the Markdown pages in docs/.

Usage:  python3 build_help.py

The same docs/*.md files are the GitHub wiki's pages (see docs/For-developers.md), so they use
wiki-style links without an extension, like [Toolchangers](Toolchangers). This script adds .html
to those links, turns Home into index.html and copies docs/images/ to help/images/.

No packages needed: it understands the small part of Markdown the help pages use (headings,
paragraphs, lists, tables, code blocks, images, links, **bold**, *italic* and `code`).
_Sidebar.md and _Footer.md are wiki-only and are skipped.
"""
import html
import os
import re
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, 'docs')
OUT = os.path.join(ROOT, 'help')

# Page order for the navigation; the title comes from each page's first heading.
PAGES = ['Home', 'Getting-started', 'Painting-tools', 'Filaments-and-mixes', 'Exporting',
         'Toolchangers', 'Tips-and-limits', 'FAQ', 'For-developers']
NAV = {'Home': 'Help home', 'Exporting': 'Exporting and print check', 'FAQ': 'FAQ and troubleshooting'}


def slug(text):
    """GitHub's heading anchors: lowercase, punctuation dropped, spaces to dashes."""
    text = re.sub(r'<[^>]+>', '', text).lower()
    return re.sub(r'[^\w\- ]', '', text).replace(' ', '-')


def href(target):
    """Wiki link → site link. Outside links and anchors are kept as they are."""
    if re.match(r'^[a-z]+:|^#|^/', target) or '.' in target.split('#')[0]:
        return target
    page, _, anchor = target.partition('#')
    page = 'index' if page == 'Home' else page
    return page + '.html' + ('#' + anchor if anchor else '')


def inline(text):
    """Escape, then apply code, images, links, bold and italic."""
    codes = []
    text = re.sub(r'`([^`]+)`', lambda m: codes.append(m.group(1)) or '\x00%d\x00' % (len(codes) - 1), text)
    text = html.escape(text, quote=False)
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)',
                  lambda m: '<img src="%s" alt="%s" loading="lazy">' % (m.group(2), html.escape(m.group(1))), text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: '<a href="%s">%s</a>' % (href(m.group(2)), m.group(1)), text)
    text = re.sub(r'(?<![\w"/>])(https://[^\s<)*]+[^\s<).,;:*])', r'<a href="\1">\1</a>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<em>\1</em>', text)
    return re.sub('\x00(\\d+)\x00', lambda m: '<code>%s</code>' % html.escape(codes[int(m.group(1))]), text)


def render(md):
    """Markdown → HTML for the subset used in docs/. Returns (title, html)."""
    lines = md.split('\n')
    out, title, i = [], '', 0
    para = []

    def flush():
        if para:
            # A line that is all bold (a FAQ question) keeps its line break.
            parts = []
            for j, ln in enumerate(para):
                parts.append(inline(ln))
                if j < len(para) - 1:
                    parts.append('<br>' if re.fullmatch(r'\*\*.+\*\*', ln.strip()) else ' ')
            body = ''.join(parts)
            out.append('<figure>%s</figure>' % body if re.fullmatch(r'<img [^>]+>', body) else '<p>%s</p>' % body)
            para.clear()

    def parse_list(i, indent):
        """Lists, nested by indentation. Returns (html, next line index)."""
        first = lines[i].lstrip()
        tag = 'ol' if re.match(r'\d+\. ', first) else 'ul'
        items = []
        while i < len(lines):
            ln = lines[i]
            ind = len(ln) - len(ln.lstrip())
            m = re.match(r'(\d+\.|-) (.*)', ln.lstrip())
            if not ln.strip() or ind < indent or not m:
                break
            if ind > indent:
                sub, i = parse_list(i, ind)
                items[-1] += sub
                continue
            items.append(inline(m.group(2)))
            i += 1
        return '<%s>%s</%s>' % (tag, ''.join('<li>%s</li>' % x for x in items), tag), i

    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if s.startswith('```'):
            flush()
            j = i + 1
            while not lines[j].strip().startswith('```'):
                j += 1
            out.append('<pre><code>%s</code></pre>' % html.escape('\n'.join(lines[i + 1:j])))
            i = j + 1
        elif re.match(r'#{1,4} ', s):
            flush()
            level = len(s.split(' ')[0])
            text = inline(s[level + 1:])
            if level == 1 and not title:
                title = re.sub(r'<[^>]+>', '', text)
                out.append('<h1>%s</h1>' % text)
            else:
                out.append('<h%d id="%s">%s</h%d>' % (level, slug(text), text, level))
            i += 1
        elif s.startswith('|'):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            head, body = rows[0], [r for r in rows[1:] if not all(re.fullmatch(r':?-+:?', c) for c in r)]
            out.append('<div class="table"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (
                ''.join('<th>%s</th>' % inline(c) for c in head),
                ''.join('<tr>%s</tr>' % ''.join('<td>%s</td>' % inline(c) for c in r) for r in body)))
        elif re.match(r'(\d+\.|-) ', s) and not para:
            flush()
            block, i = parse_list(i, len(ln) - len(ln.lstrip()))
            out.append(block)
        elif not s:
            flush()
            i += 1
        else:
            para.append(s)
            i += 1
    flush()
    return title, '\n'.join(out)


def logo():
    """The app's logo symbol and gradient, taken from src/app.html so there is one copy."""
    with open(os.path.join(ROOT, 'src', 'app.html'), encoding='utf-8') as f:
        s = f.read()
    sym = re.search(r'<symbol id="logoMark".*?</symbol>', s, re.S).group(0)
    grad = re.search(r'<linearGradient id="logoGrad".*?</linearGradient>', s, re.S).group(0)
    return '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>%s%s</defs></svg>' % (grad, sym)


PAGE = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · CthulHue help</title>
<meta name="description" content="{desc}">
<link rel="stylesheet" href="help.css">
<script>try {{ var t = JSON.parse(localStorage.getItem('labcraft.theme') || 'null'); if (t) document.documentElement.dataset.theme = t; }} catch (e) {{}}</script>
</head>
<body>
{logo}
<header>
  <a class="brand" href="index.html"><svg class="logo" viewBox="0 0 1617 1465" aria-hidden="true"><use href="#logoMark"/></svg>CthulHue <span>help</span></a>
  <a class="open" href="../">Open the app</a>
</header>
<div class="wrap">
<nav aria-label="Help pages">
{nav}
</nav>
<main>
{body}
<footer>
  {prevnext}
  <p>Something missing or wrong? <a href="https://github.com/LabcraftStudio/CthulHue/issues">Open an issue</a> · <a href="https://github.com/LabcraftStudio/CthulHue/edit/main/docs/{name}.md">Edit this page</a> · Also on the <a href="https://github.com/LabcraftStudio/CthulHue/wiki/{wiki}">GitHub wiki</a></p>
  <p>CthulHue by Sarah at Labcraft Studio · Free software under the AGPL-3.0</p>
</footer>
</main>
</div>
</body>
</html>
'''

CSS = '''/* Generated by build_help.py. Colors match the app (src/app.html). */
:root{--bg:#e8e5df;--panel:#fbfaf7;--ink:#1e1d1b;--muted:#6d6a64;--line:#dcd8d0;--accent:#1f6f6b;--accent-ink:#fff;--code:#efece6}
:root[data-theme=dark]{--bg:#17181b;--panel:#232428;--ink:#ecebe8;--muted:#a19e98;--line:#3a3b40;--accent:#4fb3ac;--accent-ink:#0f1f1e;--code:#2c2d32}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#17181b;--panel:#232428;--ink:#ecebe8;--muted:#a19e98;--line:#3a3b40;--accent:#4fb3ac;--accent-ink:#0f1f1e;--code:#2c2d32}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
a{color:var(--accent)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;max-width:1180px;margin:0 auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;color:var(--ink);text-decoration:none}
.brand span{font-weight:400;color:var(--muted)}
.logo{width:40px;height:36px}
.open{background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;padding:9px 16px;border-radius:12px;white-space:nowrap}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);gap:20px;max-width:1180px;margin:0 auto;padding:0 20px 40px}
nav{position:sticky;top:16px;align-self:start;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:10px}
nav a{display:block;padding:8px 12px;border-radius:10px;color:var(--ink);text-decoration:none;font-size:15px;line-height:1.35}
nav a:hover{background:var(--code)}
nav a.on{background:var(--accent);color:var(--accent-ink);font-weight:600}
main{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px 40px 20px;min-width:0}
h1{font-size:34px;line-height:1.2;margin:4px 0 16px}
h2{font-size:24px;margin:36px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:19px;margin:26px 0 6px}
p,li{max-width:46em}
li{margin:4px 0}
li>ul,li>ol{margin:4px 0}
code{background:var(--code);padding:1px 6px;border-radius:6px;font-size:.88em;font-family:ui-monospace,Menlo,monospace}
pre{background:var(--code);padding:14px 16px;border-radius:12px;overflow:auto;font-size:14px;line-height:1.5}
pre code{background:none;padding:0}
figure{margin:20px 0}
img{max-width:100%;max-height:620px;width:auto;height:auto;border-radius:12px;border:1px solid var(--line);display:block}
.table{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;font-size:15px;min-width:60%}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
.pn{display:flex;justify-content:space-between;gap:12px;margin-bottom:12px;font-size:16px}
.pn a{text-decoration:none;font-weight:600}
@media (max-width:820px){
  .wrap{grid-template-columns:1fr}
  nav{position:static;display:flex;flex-wrap:wrap;gap:4px}
  nav a{padding:6px 10px;font-size:14px}
  main{padding:20px 18px}
  h1{font-size:28px}
}
'''


def main():
    os.makedirs(OUT, exist_ok=True)
    pages = []
    for name in PAGES:
        with open(os.path.join(DOCS, name + '.md'), encoding='utf-8') as f:
            md = f.read()
        title, body = render(md)
        first = re.search(r'\n\n([^#!\n|][^\n]+)', md)
        desc = re.sub(r'[*`\[\]]|\([^)]*\)', '', first.group(1)) if first else title
        pages.append((name, title, body, desc[:160]))

    svg = logo()
    for k, (name, title, body, desc) in enumerate(pages):
        file = 'index' if name == 'Home' else name
        nav = '\n'.join('<a href="%s"%s>%s</a>' % (href(n), ' class="on" aria-current="page"' if n == name else '',
                                                   html.escape(NAV.get(n, t))) for n, t, _, _ in pages)
        prev = '<a href="%s">← %s</a>' % (href(pages[k - 1][0]), html.escape(pages[k - 1][1])) if k else '<span></span>'
        nxt = '<a href="%s">%s →</a>' % (href(pages[k + 1][0]), html.escape(pages[k + 1][1])) if k + 1 < len(pages) else '<span></span>'
        page = PAGE.format(title=html.escape(title), desc=html.escape(desc, quote=True), logo=svg, nav=nav, body=body,
                           prevnext='<div class="pn">%s%s</div>' % (prev, nxt), name=name, wiki=name)
        with open(os.path.join(OUT, file + '.html'), 'w', encoding='utf-8') as f:
            f.write(page)

    with open(os.path.join(OUT, 'help.css'), 'w', encoding='utf-8') as f:
        f.write(CSS)
    shutil.rmtree(os.path.join(OUT, 'images'), ignore_errors=True)
    shutil.copytree(os.path.join(DOCS, 'images'), os.path.join(OUT, 'images'))
    print('help/:', len(pages), 'pages')


if __name__ == '__main__':
    main()
