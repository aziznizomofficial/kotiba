#!/usr/bin/env python3
"""Fetch every model in Manifest.json and verify its sha256. Task B-05.

Models never enter git. GitHub Releases allows 2 GiB per asset with no total-size or
bandwidth limit; git-lfs on Free caps a single file at 2 GB and meters bandwidth. So the
manifest is a list of routes and hashes, and this is the only thing that reads it.

Two kinds of route:

  "url"      a public download, fetched over plain HTTPS.
  "release"  the same asset on a release of this repository, fetched through `gh`, which
             carries your credential. The fallback when the plain GET fails — as it does for
             every asset while the repository is private. {repo, tag, asset}.

An entry with neither is a failure, not a skip. This script used to skip entries marked
"pending-selfhost" and exit 0, which meant `make bootstrap` reported success while
downloading nothing at all. A green command that does nothing is worse than no command.

  --public  prefer the plain url over the release route: the stranger's view. For the Uzbek
            engine that url is live only once the repository is public (see its url_status).
  --check   resolve every route and verify every cached file without downloading anything.
            This is the cheap test that a recovery would work: run it now, not during the
            emergency, because a URL that rotted is silent until you need it.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def gh_download(release, dest):
    """Pull one asset off a release via `gh`, which handles auth for a private repo."""
    if not shutil.which("gh"):
        raise RuntimeError(
            f"{release['asset']} lives on a release of the private repo {release['repo']}, "
            "which needs `gh`. Install it (brew install gh) and `gh auth login`."
        )
    proc = subprocess.run(
        ["gh", "release", "download", release["tag"],
         "--repo", release["repo"],
         "--pattern", release["asset"],
         "--output", dest, "--clobber"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"gh release download failed for {release['asset']}: "
            f"{(proc.stderr or proc.stdout).strip()}\n"
            "If this says 'release not found', check `gh auth status` — the repo is private."
        )


PUBLIC = False  # --public: take the plain url even when a release route exists


PUBLIC_BASE = ""  # the manifest's public_models_base, set in main()


def public_url(entry):
    """The plain-HTTPS route: an explicit url, or public_models_base + public_asset."""
    if entry.get("url"):
        return entry["url"]
    if entry.get("public_asset") and PUBLIC_BASE:
        return PUBLIC_BASE + entry["public_asset"]
    return None


def route_of(entry):
    """(kind, description) for the manifest entry, or (None, why-not).

    The public route wins when it answers; an entry that also names a `release` falls back to it
    (through gh) while the public host is still a placeholder — see public_models_base."""
    url = public_url(entry)
    if url and (PUBLIC or not entry.get("release") or reachable(url)):
        return "url", url
    if entry.get("release"):
        r = entry["release"]
        return "release", f"{r['repo']} release {r['tag']} → {r['asset']}"
    if entry.get("url"):
        return "url", entry["url"]
    return None, "no url and no release — nothing can fetch this file"


def reachable(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
            return 200 <= r.status < 400
    except Exception:
        return False


def check(entry, dest_root):
    """Resolve the route and verify the cached copy. Downloads nothing."""
    name = entry["name"]
    dest = os.path.join(dest_root, entry["dest"])
    kind, where = route_of(entry)

    if kind is None:
        print(f"  FAIL  {name}: {where}", file=sys.stderr)
        return False

    ok = True
    if kind == "url":
        req = urllib.request.Request(where, method="HEAD")
        try:
            with urllib.request.urlopen(req) as r:
                print(f"  route {name}: {r.status} {where}")
        except urllib.error.URLError as e:
            print(f"  FAIL  {name}: route unreachable — {e}", file=sys.stderr)
            ok = False
    else:
        r = entry["release"]
        proc = subprocess.run(
            ["gh", "release", "view", r["tag"], "--repo", r["repo"], "--json", "assets"],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(f"  FAIL  {name}: cannot read release — {(proc.stderr or '').strip()}",
                  file=sys.stderr)
            ok = False
        else:
            assets = json.loads(proc.stdout)["assets"]
            hit = next((a for a in assets if a["name"] == r["asset"]), None)
            if hit is None:
                print(f"  FAIL  {name}: {r['asset']} is not on release {r['tag']}",
                      file=sys.stderr)
                ok = False
            else:
                size = hit.get("size")
                print(f"  route {name}: present, {size} bytes — {where}")
                if entry.get("bytes") and size != entry["bytes"]:
                    print(f"  FAIL  {name}: asset is {size} bytes, manifest says "
                          f"{entry['bytes']}", file=sys.stderr)
                    ok = False

    if os.path.exists(dest):
        got = sha256(dest)
        if got == entry["sha256"]:
            print(f"  ok    {name} cached and verified")
        else:
            print(f"  FAIL  {name}: cached copy is {got[:12]}…, manifest says "
                  f"{entry['sha256'][:12]}…", file=sys.stderr)
            ok = False
    else:
        print(f"  --    {name} not present locally")
    return ok


def fetch(entry, dest_root):
    name = entry["name"]
    dest = os.path.join(dest_root, entry["dest"])
    kind, where = route_of(entry)

    if kind is None:
        print(f"  FAIL  {name}: {where}", file=sys.stderr)
        return False

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        got = sha256(dest)
        if got == entry["sha256"]:
            print(f"  ok    {name} (cached)")
            return True
        print(f"  stale {name}: sha256 {got[:12]}… != {entry['sha256'][:12]}…, refetching")

    print(f"  GET   {name} → {dest}")
    tmp = dest + ".part"
    try:
        if kind == "release":
            gh_download(entry["release"], tmp)
        else:
            with urllib.request.urlopen(where) as r, open(tmp, "wb") as f:
                while block := r.read(1 << 20):
                    f.write(block)
    except Exception as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        print(f"  FAIL  {name}: {e}", file=sys.stderr)
        return False

    got = sha256(tmp)
    if got != entry["sha256"]:
        os.remove(tmp)
        print(f"  FAIL  {name}: sha256 {got} != {entry['sha256']}", file=sys.stderr)
        return False
    os.rename(tmp, dest)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", required=True, help="model root, e.g. ~/Library/Application Support/Kotiba/models")
    ap.add_argument("--manifest", default=os.path.join(HERE, "Manifest.json"))
    ap.add_argument("--check", action="store_true",
                    help="resolve routes and verify cached files without downloading")
    ap.add_argument("--optional", action="store_true",
                    help="also fetch the optional languages' models (entries marked optional — "
                         "Arabic's 1.77 GB Cohere GGUF); the app fetches them itself on demand")
    ap.add_argument("--public", action="store_true",
                    help="use each entry's public url even where a gh release route exists — "
                         "what a stranger without credentials would get")
    args = ap.parse_args()
    global PUBLIC
    PUBLIC = args.public

    manifest = json.load(open(args.manifest))
    global PUBLIC_BASE
    PUBLIC_BASE = manifest.get("public_models_base", "")
    # A bundle is a Core ML directory, pinned file by file. Each file is an ordinary entry to
    # this script; `bootstrap: false` bundles exist only for the probe's measurements.
    for bundle in manifest.get("bundles", []):
        if not bundle.get("bootstrap"):
            continue
        for f in bundle["files"]:
            manifest["models"].append({
                "name": f"{bundle['name']} · {f['path']}",
                "dest": f"{bundle['directory']}/{f['path']}",
                "url": f"https://huggingface.co/{bundle['repo']}/resolve/{bundle['revision']}/{f['path']}",
                "sha256": f["sha256"],
                "bytes": f["bytes"],
            })
    if not args.optional:
        manifest["models"] = [m for m in manifest["models"] if not m.get("optional")]
    dest_root = os.path.expanduser(args.dest)
    verb = "checking" if args.check else "→"
    print(f"{len(manifest['models'])} models {verb} {dest_root}")

    run = check if args.check else fetch
    results = [run(e, dest_root) for e in manifest["models"]]
    failed = results.count(False)

    if args.check:
        print(f"\n{len(results) - failed} of {len(results)} routes usable")
    else:
        print(f"\n{results.count(True)} fetched, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
