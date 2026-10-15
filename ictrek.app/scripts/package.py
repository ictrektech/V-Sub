#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import tarfile
import urllib.request
from pathlib import Path

import yaml
from resolve_dependencies import resolve_dependencies


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
DIST = ROOT / "dist"
SPREADSHEET = "Htotsn3oahO1zxt73YMcaB1zn8e"
REPOSITORY = "swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-sub"
PROFILES = {
    "VSUB_AMD_IMAGE": ["AMD_with_mxn100"],
    "VSUB_AMD_CUDA_IMAGE": ["AMD_with_cuda"],
    "VSUB_ARM_IMAGE": ["ARM_without_cuda", "SOPHON_bm1688"],
    "VSUB_ARM_CUDA_IMAGE": ["ARM_with_cuda"],
    "VSUB_L4T_IMAGE": ["l4t"],
    "VSUB_THOR_IMAGE": ["thor_spark"],
}


def request(method: str, url: str, token: str = "", body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method)) as response:
        value = json.load(response)
    if value.get("code") != 0:
        raise RuntimeError(value)
    return value


def cell_text(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "".join(cell_text(part) for part in value).strip()
    if isinstance(value, dict):
        return str(value.get("text") or value.get("link") or "").strip()
    return "" if value is None else str(value).strip()


def column_name(index: int) -> str:
    output = ""
    while index:
        index, rem = divmod(index - 1, 26)
        output = chr(65 + rem) + output
    return output


class Feishu:
    def __init__(self) -> None:
        configured = os.getenv("FEISHU_CONFIG_FILE")
        paths = [Path(configured)] if configured else [Path.home() / ".feishu.components.json", Path.home() / ".feishu.json"]
        path = next((candidate for candidate in paths if candidate.is_file() and candidate.stat().st_size), None)
        if path is None:
            raise RuntimeError("Feishu credential file not found")
        config = json.loads(path.read_text())
        login = request(
            "POST",
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            body={"app_id": config["feishu_app_id"], "app_secret": config["feishu_app_secret"]},
        )
        self.token = login["tenant_access_token"]
        self.base = "https://open.feishu.cn/open-apis/sheets"
        response = request("GET", f"{self.base}/v3/spreadsheets/{SPREADSHEET}/sheets/query", self.token)
        self.sheets = {row["title"]: row["sheet_id"] for row in response["data"]["sheets"]}

    def latest_image(self, title: str, component: str = "v-sub") -> str:
        sheet_id = self.sheets[title]
        response = request("GET", f"{self.base}/v2/spreadsheets/{SPREADSHEET}/values/{sheet_id}!A1:ZZ2", self.token)
        rows = response.get("data", {}).get("valueRange", {}).get("values", [])
        header = rows[0] if rows else []
        repos = rows[1] if len(rows) > 1 else []
        column = next((index for index, value in enumerate(header, 1) if cell_text(value) == component), None)
        if column is None:
            raise RuntimeError(f"{component} column missing from {title}")
        repository = cell_text(repos[column - 1]) if len(repos) >= column else REPOSITORY
        response = request(
            "GET",
            f"{self.base}/v2/spreadsheets/{SPREADSHEET}/values/{sheet_id}!{column_name(column)}4:{column_name(column)}2000",
            self.token,
        )
        values = response.get("data", {}).get("valueRange", {}).get("values", [])
        tag = next((cell_text(row[0]) for row in values if row and cell_text(row[0])), "")
        if not tag:
            raise RuntimeError(f"v-sub tag missing from {title}")
        return f"{repository or REPOSITORY}:{tag}"


def render(version: str, images: dict[str, str], stage: Path) -> None:
    stage.mkdir(parents=True)
    for name in ("manifest.yml", "configs.yml", "routers.yml", "README.zh-CN.md", "README.en.md"):
        text = (SRC / name).read_text(encoding="utf-8").replace("__APP_VERSION__", version)
        (stage / name).write_text(text, encoding="utf-8")
    shutil.copy2(SRC / "icon.png", stage / "icon.png")
    env = "".join(f"{key}={value}\n" for key, value in images.items())
    (stage / ".env").write_text(env, encoding="utf-8")
    compose = (SRC / "docker-compose.yml").read_text(encoding="utf-8").replace("__APP_VERSION__", version)
    compose = re.sub(
        r"\$\{([A-Z0-9_]+)(?::-[^}]*)?\}",
        lambda match: images.get(match.group(1), match.group(0)),
        compose,
    )
    (stage / "docker-compose.yml").write_text(compose, encoding="utf-8")
    if re.search(r"\$\{[^}]*_IMAGE[^}]*\}", compose):
        raise RuntimeError("unrendered image variable remains")


def resolve_manifest(stage: Path) -> None:
    manifest_path = stage / "manifest.yml"
    manifest = yaml.safe_load(manifest_path.read_text())
    resolved = resolve_dependencies(manifest, {"com.ictrek.v-scheduler": "ictrektech/V-Scheduler"})
    manifest_path.write_text(yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False))
    for dependency in resolved:
        print(f"Dependency resolved: {dependency['id']} published={dependency['published']} package={dependency['requirement']}")


def package(version: str, stage: Path) -> Path:
    DIST.mkdir(exist_ok=True)
    app_tar = DIST / "app.tar.gz"
    members = [".env", "manifest.yml", "docker-compose.yml", "configs.yml", "routers.yml", "icon.png", "README.zh-CN.md", "README.en.md"]
    with tarfile.open(app_tar, "w:gz") as archive:
        for name in members:
            archive.add(stage / name, arcname=name)
    output = DIST / f"v_sub_{version}_pull.tar"
    payload = app_tar.read_bytes()
    info = tarfile.TarInfo("app.tar.gz")
    info.size = len(payload)
    with tarfile.open(output, "w") as archive:
        archive.addfile(info, io.BytesIO(payload))
    with tarfile.open(output) as archive:
        if archive.getnames() != ["app.tar.gz"]:
            raise RuntimeError("invalid outer package")
    with tarfile.open(app_tar) as archive:
        if set(archive.getnames()) != set(members):
            raise RuntimeError("invalid inner package")
    for name in members:
        if name.endswith(('.yml', '.md')):
            text = (stage / name).read_text()
            if re.search(r"__[A-Z0-9_]+__", text):
                raise RuntimeError(f"unrendered placeholder in {name}")
    compose = (stage / "docker-compose.yml").read_text()
    for image in re.findall(r"^\s*image:\s*(.+)$", compose, re.M):
        if not re.fullmatch(r"[a-zA-Z0-9.-]+\.[a-zA-Z0-9.-]+/[a-zA-Z0-9_./:-]+", image.strip('"\'')):
            raise RuntimeError(f"invalid image reference: {image}")
    if 'external: true' not in compose or 'aliases:' not in compose or 'vos_default:' not in compose:
        raise RuntimeError("missing VOS network or aliases")
    if '/export:/modelhub:ro' not in compose or 'MODEL_HUB_EXPORTS_PATH: /modelhub' not in compose:
        raise RuntimeError('Model Hub must mount only public exports read-only')
    routers = (stage / "routers.yml").read_text()
    for field in ['id: v-sub', 'kind: page', '/app/com.ictrek.v-sub/', 'entry-point: true', 'embed: true']:
        if field not in routers:
            raise RuntimeError(f"missing route field: {field}")
    if 'kind: group' in routers or 'children:' in routers:
        raise RuntimeError("V-Sub must use one top-level page without nested groups")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default=os.getenv("PACKAGE_VERSION", ""))
    args = parser.parse_args()
    version = args.version or (ROOT / "VERSION").read_text().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit(f"invalid version: {version}")
    feishu = Feishu()
    images = {}
    for variable, sheets in PROFILES.items():
        errors = []
        for sheet in sheets:
            try:
                images[variable] = feishu.latest_image(sheet)
                break
            except Exception as exc:
                errors.append(str(exc))
        if variable not in images:
            raise RuntimeError("; ".join(errors))
    stage = DIST / "staging"
    if stage.exists():
        shutil.rmtree(stage)
    render(version, images, stage)
    resolve_manifest(stage)
    output = package(version, stage)
    print(output)


if __name__ == "__main__":
    main()
