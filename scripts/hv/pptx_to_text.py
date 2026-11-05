#!/usr/bin/env python3
"""Extract slide text from a .pptx (zip of XML) using stdlib only."""
import re, sys, zipfile

def slide_key(name):
    m = re.search(r"slide(\d+)\.xml$", name)
    return int(m.group(1)) if m else 0

def main(pptx_path):
    with zipfile.ZipFile(pptx_path) as z:
        slides = sorted((n for n in z.namelist()
                         if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=slide_key)
        for n in slides:
            xml = z.read(n).decode("utf-8", errors="replace")
            texts = re.findall(r"<a:t>(.*?)</a:t>", xml, flags=re.S)
            print(f"\n===== Slide {slide_key(n)} =====")
            for t in texts:
                t = (t.replace("&amp;", "&").replace("&lt;", "<")
                      .replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'"))
                if t.strip():
                    print(t.strip())

if __name__ == "__main__":
    main(sys.argv[1])
