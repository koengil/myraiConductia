#!/usr/bin/env python3
"""Build a PLACEHOLDER external Data Room (the CLIENT's own documents).

Storm (2026-07-09): the Data Room = the client's documents about itself
(external source material); the Deal Folder = our internal work product. These
are distinct and were conflated. The Project Destiny folder we ingested is the
Deal Folder. This builds a placeholder Data Room until Dan provides the real
VDR index — a standard sell-side virtual-data-room structure with placeholder
files (browser-previewable .txt) so the explorer works end to end.
"""
import json, os, shutil

REPO = "/Users/lancemarks/Documents/Projects/Claude/Futureproofing/intelibank"
FILES = os.path.join(REPO, "public/data-room-external")
MANIFEST = os.path.join(REPO, "src/lib/dataroom/data-room-manifest.json")

# Standard sell-side VDR index (folder -> list of placeholder documents).
INDEX = {
    "01. Corporate & Organization": [
        "Certificate of Incorporation.txt",
        "Bylaws and Amendments.txt",
        "Capitalization Table.txt",
        "Organizational Chart.txt",
    ],
    "02. Financial Information": [
        "Audited Financial Statements (FY22-FY24).txt",
        "Management Accounts (YTD).txt",
        "Annual Budget and Forecast.txt",
        "Accounts Receivable Aging.txt",
    ],
    "03. Commercial & Customers": [
        "Top 20 Customer Contracts.txt",
        "Customer Concentration Analysis.txt",
        "Sales Pipeline Summary.txt",
    ],
    "04. Legal & Contracts": [
        "Material Contracts Schedule.txt",
        "Litigation Summary.txt",
        "Permits and Licenses.txt",
    ],
    "05. Human Resources": [
        "Employee Census.txt",
        "Key Employee Agreements.txt",
        "Benefits Summary.txt",
    ],
    "06. Technology & IP": [
        "IP Register (Patents & Trademarks).txt",
        "Software and Systems Overview.txt",
        "Data Security and Privacy.txt",
    ],
    "07. Tax": [
        "Tax Returns (FY22-FY24).txt",
        "Tax Compliance Summary.txt",
    ],
    "08. Real Estate & Assets": [
        "Property and Lease Schedule.txt",
        "Fixed Asset Register.txt",
    ],
    "09. Insurance": [
        "Insurance Policy Schedule.txt",
    ],
    "10. Regulatory & Compliance": [
        "Regulatory Filings.txt",
        "Compliance Policies.txt",
    ],
}

PLACEHOLDER = (
    "PLACEHOLDER — external data room document.\n\n"
    "This is the CLIENT's own document (source material the client provides), "
    "distinct from our internal Deal Folder (our work product).\n\n"
    "The real virtual-data-room index and files will be supplied by the "
    "Ignatious team (Dan). This placeholder exists so the Data Room explorer "
    "is fully navigable end to end.\n"
)


def slug(s):
    import re
    s = s.lower()
    s = re.sub(r"[^\w\s.-]", "", s)
    s = re.sub(r"[\s_]+", "-", s.strip())
    return re.sub(r"-+", "-", s)


def slug_file(name):
    base, ext = name.rsplit(".", 1)
    return slug(base) + "." + ext.lower()


def build():
    if os.path.isdir(FILES):
        shutil.rmtree(FILES)
    os.makedirs(FILES, exist_ok=True)
    children = []
    nfiles = 0
    for folder, docs in INDEX.items():
        fslug = slug(folder)
        os.makedirs(os.path.join(FILES, fslug), exist_ok=True)
        kids = []
        for doc in docs:
            dslug = slug_file(doc)
            body = f"{doc}\n{'=' * len(doc)}\n\n{PLACEHOLDER}"
            path = os.path.join(FILES, fslug, dslug)
            open(path, "w").write(body)
            href = f"/data-room-external/{fslug}/{dslug}"
            kids.append({
                "name": doc, "kind": "file", "ext": "txt",
                "size": f"{len(body)} B", "bytes": len(body),
                "href": href, "preview": href,  # .txt renders in the iframe
                "tags": [],  # meta-tagging hook (Storm §11 — future Enterprise Search)
            })
            nfiles += 1
        children.append({"name": folder, "kind": "folder", "children": kids})

    manifest = {
        "root": "Project Destiny — Data Room (Client Documents)",
        "kind": "data-room",
        "note": "The client's own documents — external source material provided for buyer evaluation. Distinct from the internal Deal Folder. PLACEHOLDER pending the real VDR index from the Ignatious team.",
        "children": children,
        "counts": {"files": nfiles, "folders": len(INDEX)},
    }
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    json.dump(manifest, open(MANIFEST, "w"), indent=1)
    print(f"OK: external data room — {nfiles} placeholder files across {len(INDEX)} folders. Manifest -> {MANIFEST}")


if __name__ == "__main__":
    build()
