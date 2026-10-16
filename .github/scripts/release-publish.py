#!/usr/bin/env python3
"""Create the GitHub release for a tag and upload every file in a directory.

usage: release-publish.py TAG DIR [NOTES_FILE] [--prerelease]

Reads GITHUB_TOKEN and GITHUB_REPOSITORY from the environment. Uses only the
standard library, so it runs in a bare python image. Nothing is published to a
package registry: GitHub release assets are the only distribution channel.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"


def request(method: str, url: str, token: str, body: bytes | None = None,
            content_type: str = "application/json") -> dict:
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if body is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        print(f"::error::{method} {url} -> {error.code}: {error.read().decode()[:500]}", file=sys.stderr)
        raise
    return json.loads(raw) if raw else {}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    prerelease = "--prerelease" in sys.argv
    tag, directory = args[0], Path(args[1])
    notes = Path(args[2]).read_text(encoding="utf-8") if len(args) > 2 else ""
    token, repository = os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"]

    release = request(
        "POST",
        f"{API}/repos/{repository}/releases",
        token,
        json.dumps(
            {
                "tag_name": tag,
                "name": tag,
                "body": notes,
                "prerelease": prerelease,
                "generate_release_notes": not notes.strip(),
            }
        ).encode(),
    )
    for path in sorted(p for p in directory.iterdir() if p.is_file()):
        query = urllib.parse.urlencode({"name": path.name})
        request(
            "POST",
            f"{UPLOADS}/repos/{repository}/releases/{release['id']}/assets?{query}",
            token,
            path.read_bytes(),
            "application/octet-stream",
        )
        print(f"uploaded {path.name}")
    print(f"ok - {release['html_url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
