#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
sheet=""; build=true; publish=true; mode=full; gateway_only=false; app_only=false; backend_only=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-only) backend_only=true; shift ;;
    --app-only) app_only=true; shift ;;
    --gateway-only) gateway_only=true; shift ;;
    --sheet) sheet="$2"; shift 2 ;;
    --build-only) [[ "$mode" == full ]]; mode=build-only; publish=false; shift ;;
    --publish-only) [[ "$mode" == full ]]; mode=publish-only; build=false; shift ;;
    *) echo "Usage: $0 --sheet AMD_with_mxn100|AMD_with_cuda|ARM_without_cuda|ARM_with_cuda|l4t|thor_spark [--build-only|--publish-only]" >&2; exit 1 ;;
  esac
done
case "$sheet" in
  AMD_with_mxn100) arch=amd64; prefix=amd; profile=amd; gpu=false; sheets=(AMD_with_mxn100) ;;
  AMD_with_cuda) arch=amd64; prefix=amd_cu128; profile=amd-cuda; gpu=true; sheets=(AMD_with_cuda) ;;
  ARM_without_cuda) arch=arm64; prefix=arm; profile=arm; gpu=false; sheets=(ARM_without_cuda SOPHON_bm1688) ;;
  ARM_with_cuda) arch=arm64; prefix=arm_cu130; profile=arm-cuda; gpu=true; sheets=(ARM_with_cuda) ;;
  l4t) arch=arm64; prefix=l4t; profile=l4t; gpu=true; sheets=(l4t) ;;
  thor_spark) arch=arm64; prefix=thor; profile=thor; gpu=true; sheets=(thor_spark) ;;
  *) echo "An explicit supported --sheet is required" >&2; exit 1 ;;
esac
case "$(uname -m)" in x86_64) actual=amd64 ;; aarch64|arm64) actual=arm64 ;; *) exit 1 ;; esac
[[ "$actual" == "$arch" ]] || { echo "Host architecture does not match sheet" >&2; exit 1; }
registry=swr.cn-southwest-2.myhuaweicloud.com/ictrek
date_tag=$(TZ=Asia/Shanghai date +%Y%m%d)
image="${registry}/v-sub:${prefix}_${date_tag}"
export FEISHU_CONFIG_FILE="${FEISHU_CONFIG_FILE:-${HOME}/.feishu.components.json}"
[[ -s "$FEISHU_CONFIG_FILE" ]] || export FEISHU_CONFIG_FILE="$HOME/.feishu.json"
if [[ "$build" == true ]]; then
  if [[ "$backend_only" == true ]]; then
    if [[ "$arch" == amd64 ]]; then cpu_prefix=amd; else cpu_prefix=arm; fi
    workbench="${WORKBENCH_IMAGE:-${registry}/v-sub:${cpu_prefix}_${date_tag}}"
    base_image="${BASE_IMAGE:-$image}"
    docker image inspect "$base_image" >/dev/null
    docker buildx build --builder default --load --provenance=false --sbom=false \
      --build-arg "BASE_IMAGE=$base_image" --build-arg "WORKBENCH_IMAGE=$workbench" \
      -f docker/Dockerfile.backend -t "$image" .
  elif [[ "$app_only" == true ]]; then
    if [[ "$arch" == amd64 ]]; then cpu_prefix=amd; else cpu_prefix=arm; fi
    workbench="${WORKBENCH_IMAGE:-${registry}/v-sub:${cpu_prefix}_${date_tag}}"
    base_image="${BASE_IMAGE:-$image}"
    docker image inspect "$base_image" >/dev/null
    docker buildx build --builder default --load --provenance=false --sbom=false \
      --build-arg "BASE_IMAGE=$base_image" --build-arg "WORKBENCH_IMAGE=$workbench" --build-arg "PROFILE=$profile" \
      -f docker/Dockerfile.app -t "$image" .
  elif [[ "$gateway_only" == true ]]; then
    docker image inspect "$image" >/dev/null
    docker buildx build --builder default --load --provenance=false --sbom=false --build-arg "BASE_IMAGE=$image" -f docker/Dockerfile.gateway -t "$image" .
  elif [[ "$gpu" == false ]]; then
    docker buildx build --builder default --load --target runtime-base --provenance=false --sbom=false \
      --build-arg "NODE_IMAGE=${registry}/node:24-bookworm-slim-${arch}" \
      -f docker/Dockerfile -t "v-sub-runtime:${prefix}" .
    docker buildx build --builder default --load --provenance=false --sbom=false \
      --build-arg "NODE_IMAGE=${registry}/node:24-bookworm-slim-${arch}" \
      -f docker/Dockerfile -t "$image" .
  else
    mkdir -p "${HOME}/dev/build/v-sub"
    exec {sherpa_lock}>"${HOME}/dev/build/v-sub/sherpa-source.lock"
    flock "$sherpa_lock"
    # Reuse V-Voice's published, profile-specific wheel/ORT/CUDA runtime.
    gpu_base=$(SHEET="$sheet" python3 - <<'PY'
import os, runpy
module = runpy.run_path('ictrek.app/scripts/package.py')
print(module['Feishu']().latest_image(os.environ['SHEET'], 'v-voice'))
PY
)
    if [[ "$arch" == amd64 ]]; then cpu_prefix=amd; else cpu_prefix=arm; fi
    workbench="${WORKBENCH_IMAGE:-${registry}/v-sub:${cpu_prefix}_${date_tag}}"
    source="${SHERPA_SOURCE_DIR:-${HOME}/dev/build/v-sub/sherpa-onnx-1.13.8}"
    if [[ ! -f "$source/scripts/node-addon-api/src/audio-tagging.cc" || ( -z "${SHERPA_SOURCE_DIR:-}" && ! -f "$source/.v-sub-complete" ) ]]; then
      [[ -z "${SHERPA_SOURCE_DIR:-}" ]] || { echo "Incomplete pinned sherpa-onnx source: $source" >&2; exit 1; }
      mkdir -p "$source"
      archive=$(mktemp "${HOME}/dev/build/v-sub/sherpa-onnx-1.13.8.XXXXXX.tar.gz")
      downloaded=false
      for proxy in https://ghfast.top/ https://gh-proxy.com/ ''; do
        if curl -fsSL --connect-timeout 10 --max-time 600 --retry 1 "${proxy}https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v1.13.8.tar.gz" -o "$archive" && tar -tzf "$archive" >/dev/null; then downloaded=true; break; fi
      done
      [[ "$downloaded" == true ]] || { echo "Cannot fetch pinned sherpa-onnx source archive" >&2; exit 1; }
      tar -xzf "$archive" --strip-components=1 -C "$source"
      touch "$source/.v-sub-complete"
      rm -f "$archive"
    fi
    context="${HOME}/dev/build/v-sub/sherpa-source"
    mkdir -p "$context/scripts" "$context/sherpa-onnx"
    tar --dereference --exclude=node_modules --exclude=build -C "$source" -cf - scripts/node-addon-api sherpa-onnx/c-api | tar -C "$context" -xf -
    docker buildx build --builder default --pull --load --provenance=false --sbom=false \
      --build-context "sherpa_source=${context}" \
      --build-arg "WORKBENCH_IMAGE=$workbench" --build-arg "GPU_BASE_IMAGE=$gpu_base" --build-arg "PROFILE=$profile" \
      -f docker/Dockerfile.gpu -t "$image" .
    flock -u "$sherpa_lock"
  fi
fi
if [[ "$publish" == true ]]; then
  docker image inspect "$image" >/dev/null
  docker push "$image"
  for title in "${sheets[@]}"; do
    python3 scripts/feishu_release.py --sheet "$title" --component v-sub --tag "${image##*:}" --repository "${registry}/v-sub"
  done
fi
echo "$image"
