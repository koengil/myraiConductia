#!/usr/bin/env python3
"""Ingest the sample Ignatious deal folder into the repo data room.

- Copies every file to public/data-room/<slugged-path> (served statically, downloadable).
- Preserves the exact folder tree (incl. empty folders) in a manifest.
- Generates in-browser previews where feasible: docx -> HTML (pandoc),
  pptx -> slide-text HTML. xlsx -> download-only.
- Writes src/lib/dataroom/manifest.json (the tree the UI renders).
"""
import json, os, re, shutil, subprocess, sys, zipfile

SRC = "/Users/lancemarks/Desktop/00. Sample Ignatious Project"
REPO = "/Users/lancemarks/Documents/Projects/Claude/Futureproofing/intelibank"
FILES_DIR = os.path.join(REPO, "public/data-room")
PREV_DIR = os.path.join(REPO, "public/data-room-previews")
MANIFEST = os.path.join(REPO, "src/lib/dataroom/manifest.json")

def slug(s):
    s = s.lower()
    s = re.sub(r"[^\w\s.-]", "", s)      # drop &, (), etc.
    s = re.sub(r"[\s_]+", "-", s.strip())
    s = re.sub(r"-+", "-", s)
    return s or "item"

def slug_path(relparts):
    # slug each segment, keep extension on the last
    out = []
    for i, p in enumerate(relparts):
        if i == len(relparts) - 1 and "." in p:
            base, ext = p.rsplit(".", 1)
            out.append(slug(base) + "." + ext.lower())
        else:
            out.append(slug(p))
    return "/".join(out)

def human_size(n):
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n/1024:.0f} {unit}" if unit == "KB" else f"{n/1048576:.1f} MB"
        n /= 1024

def pptx_text_html(path, title):
    """Extract slide text from a pptx into a simple readable HTML preview."""
    slides_html = []
    try:
        with zipfile.ZipFile(path) as z:
            names = sorted(
                (n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                key=lambda n: int(re.search(r"slide(\d+)", n).group(1)),
            )
            for i, n in enumerate(names, 1):
                xml = z.read(n).decode("utf-8", errors="replace")
                texts = re.findall(r"<a:t>(.*?)</a:t>", xml, flags=re.S)
                body = "".join(
                    f"<p>{t.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').strip()}</p>"
                    for t in texts if t.strip()
                )
                slides_html.append(f'<section class="slide"><div class="slide-no">Slide {i}</div>{body}</section>')
    except Exception as e:
        slides_html.append(f"<p>Could not read slides: {e}</p>")
    css = ("body{font:14px/1.6 -apple-system,system-ui,sans-serif;color:#151312;background:#fcfdfb;margin:0;padding:28px}"
           ".slide{background:#fff;border:1px solid #eae9e7;border-radius:12px;padding:20px 24px;margin:0 0 16px;max-width:780px}"
           ".slide-no{font:600 10px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#97918d;margin-bottom:8px}"
           ".slide p{margin:0 0 6px}h1{font-size:18px}")
    return f"<!doctype html><meta charset=utf-8><title>{title}</title><style>{css}</style><h1>{title}</h1>" + "".join(slides_html)

def build():
    if not os.path.isdir(SRC):
        print(f"SOURCE MISSING: {SRC}"); sys.exit(1)
    for d in (FILES_DIR, PREV_DIR, os.path.dirname(MANIFEST)):
        os.makedirs(d, exist_ok=True)
    # clean prior
    for d in (FILES_DIR, PREV_DIR):
        for entry in os.listdir(d):
            p = os.path.join(d, entry)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

    counts = {"files": 0, "previews": 0, "folders": 0}

    def walk(abs_dir, rel_parts):
        node_children = []
        entries = sorted(os.listdir(abs_dir))
        for name in entries:
            if name.startswith("."):
                continue
            abs_p = os.path.join(abs_dir, name)
            rp = rel_parts + [name]
            if os.path.isdir(abs_p):
                counts["folders"] += 1
                child = {"name": name, "kind": "folder", "children": walk(abs_p, rp)}
                node_children.append(child)
            else:
                counts["files"] += 1
                sp = slug_path(rp)
                dest = os.path.join(FILES_DIR, sp)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(abs_p, dest)
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                size = os.path.getsize(abs_p)
                entry = {
                    "name": name, "kind": "file", "ext": ext,
                    "size": human_size(size), "bytes": size,
                    "href": "/data-room/" + sp,
                }
                # previews
                prev_rel = sp + ".html"
                prev_dest = os.path.join(PREV_DIR, prev_rel)
                os.makedirs(os.path.dirname(prev_dest), exist_ok=True)
                if ext == "docx":
                    try:
                        subprocess.run(
                            ["pandoc", abs_p, "-f", "docx", "-t", "html", "--embed-resources",
                             "--standalone", "--metadata", f"title={name}", "-o", prev_dest],
                            check=True, capture_output=True, timeout=90,
                        )
                        entry["preview"] = "/data-room-previews/" + prev_rel
                        counts["previews"] += 1
                    except Exception as e:
                        print(f"  docx preview failed {name}: {e}")
                elif ext == "pptx":
                    try:
                        open(prev_dest, "w").write(pptx_text_html(abs_p, name))
                        entry["preview"] = "/data-room-previews/" + prev_rel
                        counts["previews"] += 1
                    except Exception as e:
                        print(f"  pptx preview failed {name}: {e}")
                node_children.append(entry)
        return node_children

    tree = walk(SRC, [])
    manifest = {
        "root": "Project Destiny — Sample Deal (Ignatious)",
        "note": "The complete sample sell-side deal folder provided by the Ignatious team.",
        "children": tree,
        "counts": counts,
    }
    json.dump(manifest, open(MANIFEST, "w"), indent=1)
    print(f"OK: {counts['files']} files, {counts['folders']} folders, {counts['previews']} previews. Manifest -> {MANIFEST}")

if __name__ == "__main__":
    build()
