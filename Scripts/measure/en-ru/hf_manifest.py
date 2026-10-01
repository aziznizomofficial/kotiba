#!/usr/bin/env python3
"""Pin a Hugging Face model directory to one commit, file by file, with sha256 and size.

    python hf_manifest.py FluidInference/parakeet-ultra-coreml <revision> \
        Preprocessor.mlmodelc Encoder.mlmodelc Decoder.mlmodelc JointDecisionv3.mlmodelc \
        parakeet_vocab.json

A Core ML model is a *directory* of files, and `ModelStore` verifies files. So a bundle is
recorded here as every file under the named paths, each with:

  path    relative to the repo root, which is also where it lands under the bundle directory
  url     https://huggingface.co/<repo>/resolve/<revision>/<path> — the commit, never `main`,
          so a re-download is the same bytes the hashes below were taken from
  sha256  for LFS files, the LFS oid (which *is* the sha256 of the content); for the small
          non-LFS files the Hub only gives a git sha1, so they are fetched and hashed here
  bytes   the content size

The JSON printed is what `Scripts/Manifest.json` carries under "bundles" and what
`ModelCatalogue` mirrors; `ModelCatalogueManifestTests` asserts the two agree.
"""
import hashlib
import json
import sys
import urllib.request


def tree(repo, revision, path):
    url = (f"https://huggingface.co/api/models/{repo}/tree/{revision}/{path}"
           "?recursive=true")
    with urllib.request.urlopen(url) as r:
        return json.load(r)


def main():
    repo, revision, *paths = sys.argv[1:]
    files = []
    for path in paths:
        entries = tree(repo, revision, path) if not path.endswith(".json") else None
        if entries is None:
            # A single top-level file: ask for its parent listing and pick it out.
            listing = tree(repo, revision, "")
            entries = [e for e in listing if e["path"] == path]
        for e in entries:
            if e["type"] != "file":
                continue
            url = f"https://huggingface.co/{repo}/resolve/{revision}/{e['path']}"
            if "lfs" in e:
                sha, size = e["lfs"]["oid"], e["lfs"]["size"]
            else:
                with urllib.request.urlopen(url) as r:
                    data = r.read()
                sha, size = hashlib.sha256(data).hexdigest(), len(data)
            files.append({"path": e["path"], "url": url, "sha256": sha, "bytes": size})
    files.sort(key=lambda f: f["path"])
    json.dump({"repo": repo, "revision": revision, "files": files}, sys.stdout, indent=2)
    print()
    print(f"{len(files)} files, {sum(f['bytes'] for f in files) / 1e6:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
