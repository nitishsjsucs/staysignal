"""The coding pass (SPEC 15.6): a separate, recorded call per post or comment assigns 1 to 3 codebook themes or
`other`, so the themes are not primed by the personas' own prompt (the codebook never appears there). Results go to
`coding.jsonl`, the calls to `coding.calls.jsonl.gz`, so the recorded provider can replay the coding too.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from staysignal_sim.client import Provider, Recorder, build_request
from staysignal_sim.personas import repo_root

CODER_SYSTEM = (
    "You code short forum posts written by synthetic personas into themes from a fixed codebook. Use only the theme "
    'IDs listed. Reply with JSON only: {"themes": [one to three theme IDs]}. Use "other" when none fits.'
)


def codebook(root: Path | None = None) -> list[dict]:
    return yaml.safe_load(((root or repo_root()) / "lab" / "codebook.yaml").read_text())["themes"]


def coding_prompt(text: str, themes: list[dict]) -> str:
    listing = "\n".join(f"- {t['id']}: {t['label']}" for t in themes)
    return f"Codebook:\n{listing}\n\nPost:\n{text}\n\nAnswer with the JSON object only."


def parse_themes(text: str, valid: set[str]) -> list[str]:
    try:
        got = json.loads(text[text.index("{") : text.rindex("}") + 1])["themes"]
    except (ValueError, KeyError, TypeError):
        return ["other"]
    themes = [t for t in got if isinstance(t, str) and t in valid][:3]
    return themes or ["other"]


async def code_run(run_dir: Path, provider: Provider) -> list[dict]:
    themes = codebook()
    valid = {t["id"] for t in themes}
    acts = [json.loads(line) for line in (run_dir / "actions.jsonl").read_text().splitlines()]
    texts = [
        (i, a)
        for i, a in enumerate(acts)
        if a["action"] in ("create_post", "create_comment") and a["persona"] != "Program office"
    ]
    rec = Recorder(provider)
    reqs = [
        (
            build_request(CODER_SYSTEM, coding_prompt(a["args"]["content"], themes), tools=None, max_tokens=40),
            "coding",
            a["persona"],
            a["round"],
        )
        for _, a in texts
    ]
    out = []
    for (i, a), (resp, idx) in zip(texts, await rec.gather(reqs), strict=True):
        out.append(
            {
                "action": i,
                "round": a["round"],
                "persona": a["persona"],
                "themes": parse_themes(resp["choices"][0]["message"].get("content") or "", valid),
                "call": idx,
            }
        )
    rec.write(run_dir, "coding.calls.jsonl.gz", systems=False)
    (run_dir / "coding.jsonl").write_text("".join(json.dumps(c, sort_keys=True) + "\n" for c in out))
    return out


__all__ = ["CODER_SYSTEM", "code_run", "codebook", "coding_prompt", "parse_themes"]
