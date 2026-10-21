# V-Sub VOS delivery

App ID: `com.ictrek.v-sub`. Browser prefix: `/app/com.ictrek.v-sub/`. Backend: `v-sub-backend:7090`, host port `22703`. The unified V-Scheduler application supplies the required model gateway. Existing `v-router` DNS and API aliases remain compatible. Packaging resolves the Scheduler dependency from its current published Release or App Store record and stops if verification fails.

The application preserves the upstream Next.js renderer and Electron background engine. A browser preload transport replaces IPC, file dialogs and the media protocol. Each verified OIDC subject owns a separate background process, storage directory and unprivileged OS UID. V-Scheduler credentials and VOS access tokens never persist in app settings. The original assistant remains available; Electron window screenshot capture is unavailable in the browser transport. Installed native models register as private V-Scheduler services; native engines execute the same code as desktop tasks.

Build on matching Linux hosts after synchronizing local source to `~/dev/repos/V-Sub`; keep logs under `~/dev/build/v-sub`. Build scripts run on that host without SSH or Git.

```bash
bash docker/build_image.sh --sheet AMD_with_mxn100 --build-only
# After runtime verification and code push:
bash docker/build_image.sh --sheet AMD_with_mxn100 --publish-only
# ARM equivalent:
bash docker/build_image.sh --sheet ARM_without_cuda --build-only
bash docker/build_image.sh --sheet ARM_without_cuda --publish-only
```

Each profile has its own image and Feishu sheet:

| Profile | Feishu sheet | Tag prefix | Native sherpa runtime |
| --- | --- | --- | --- |
| amd | AMD_with_mxn100 | amd | CPU |
| amd-cuda | AMD_with_cuda | amd_cu128 | CUDA 12, ORT 1.28.2 |
| arm | ARM_without_cuda (also SOPHON_bm1688) | arm | CPU |
| arm-cuda | ARM_with_cuda | arm_cu130 | CUDA 13, ORT 1.27.0 |
| l4t | l4t | l4t | CUDA 12, ORT 1.18.1 |
| thor | thor_spark | thor | CUDA 13, ORT 1.27.0 |

Tags use `prefix_YYYYMMDD`. Build and publish CPU images first. GPU builds reuse the corresponding published V-Voice image from Feishu, including its specialized sherpa-onnx 1.13.8 wheel libraries. The matching Node addon is compiled against that wheel's C API. The build checks CUDA/ORT version strings; incompatible wheels fail the build. The build fetches the pinned v1.13.8 source archive under `~/dev/build/v-sub`; optionally reuse a complete source tree through `SHERPA_SOURCE_DIR`. No Git runs on build machines. Source archives and native release downloads try ghfast.top and gh-proxy.com before GitHub. L4T Paraformer retains V-Voice's CPU compatibility fallback; other supported sherpa models use CUDA.

Use the same build/publish commands with the explicit GPU sheet, for example `bash docker/build_image.sh --sheet thor_spark --build-only`. All records use the `v-sub` component column in the canonical Feishu spreadsheet.

For changes confined to `vos/`, `--gateway-only` updates the verified existing profile image without rebuilding the renderer or native libraries; the normal build remains a complete source build.

After code delivery, image push and Feishu verification, run locally:

```bash
./ictrek.app/scripts/update_version.sh patch
```

CI publishes the rendered `v_sub_<version>_pull.tar`, creates the public version tag and uploads to VOS App Store. Keep upstream desktop versioning separate from `ictrek.app/VERSION`.
