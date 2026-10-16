#!/usr/bin/env python3
"""Write SHA256SUMS and the (unsigned) in-toto provenance for a release.

usage: release-manifest.py DIR

DIR holds the release artefacts. Every regular file in it that is not itself a
checksum, signature or provenance file becomes a subject. The signing step
(openssl, with the key from the organisation secret) runs afterwards on the
host and signs each artefact, SHA256SUMS and provenance.intoto.json.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

SKIP_SUFFIXES = (".sig", ".der")
SKIP_NAMES = {"SHA256SUMS", "provenance.intoto.json"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    directory = Path(sys.argv[1])
    files = sorted(
        path
        for path in directory.iterdir()
        if path.is_file() and path.name not in SKIP_NAMES and path.suffix not in SKIP_SUFFIXES
    )
    if not files:
        print("::error::no release artefacts found", file=sys.stderr)
        return 1

    sums = {path.name: sha256(path) for path in files}
    (directory / "SHA256SUMS").write_text(
        "".join(f"{digest}  {name}\n" for name, digest in sums.items()), encoding="utf-8"
    )

    env = os.environ
    repository = env["GITHUB_REPOSITORY"]
    run = f"https://github.com/{repository}/actions/runs/{env['GITHUB_RUN_ID']}"
    statement = {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [{"name": name, "digest": {"sha256": digest}} for name, digest in sums.items()],
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {
            "buildDefinition": {
                "buildType": "https://github.com/UplyTech/server-main/runner/workflow@v1",
                "externalParameters": {
                    "repository": f"https://github.com/{repository}",
                    "ref": env["GITHUB_REF"],
                    "commit": env["GITHUB_SHA"],
                    "workflow": env.get("GITHUB_WORKFLOW_REF", env.get("GITHUB_WORKFLOW", "")),
                    "runId": env["GITHUB_RUN_ID"],
                    "runAttempt": env["GITHUB_RUN_ATTEMPT"],
                },
            },
            "runDetails": {
                "builder": {"id": "https://github.com/UplyTech/server-main/runner"},
                "metadata": {"invocationId": f"{run}/attempts/{env['GITHUB_RUN_ATTEMPT']}"},
            },
        },
    }
    (directory / "provenance.intoto.json").write_text(
        json.dumps(statement, indent=2) + "\n", encoding="utf-8"
    )
    print(f"ok - {len(files)} subjects in SHA256SUMS and provenance.intoto.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
