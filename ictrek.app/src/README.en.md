# V-Sub __APP_VERSION__

Subtitle transcription, translation, proofreading, dubbing, composition and media export in a VOS browser app, preserving SmartSub's workflows and local engine management.

VOS OIDC Fastpath verifies the account. V-Router automatically supplies available ASR/TTS models, including V-Voice and configured standard cloud audio endpoints. V-Voice voices are fetched per model; standard cloud endpoints without a voice catalog use the standard OpenAI voice list.

Upload or drop files in the browser. Files, settings, tasks and local models are isolated by verified VOS account and OS identity. Exports are downloaded through the browser. Ready local ASR/TTS models are discovered privately by V-Router; V-Sub refreshes its local catalog every 30 seconds. ZipVoice is discoverable once its model and user reference voices are ready.

CPU profiles run native local CPU engines. AMD CUDA, ARM CUDA, Jetson/L4T and Thor profiles reuse V-Voice’s specialized sherpa-onnx GPU wheels and matching CUDA/ONNX Runtime libraries. L4T Paraformer uses the same CPU compatibility fallback as V-Voice. The ARM whisper.cpp addon is built from source. Engine availability reflects the actual installed runtime.

Choose Follow VOS, Simplified Chinese, Traditional Chinese or English without reloading or losing form contents. Manual language preferences belong only to V-Sub.

## Shared local models

Install Model Hub first and use its shared directory for `MODEL_HUB_SHARED_MODELS_PATH`. Model Hub downloads compatible weights from ModelScope, including missing packages mirrored under vivibit. Weights are mounted read-only. Removing a model here detaches the current account; global disk cleanup belongs to Model Hub. Personal voices and tasks remain isolated. Existing files remain usable; downloading again switches to shared weights and retains a legacy backup.

The GPU panel separates bundled sherpa-onnx runtimes from optional whisper.cpp plugins. Missing nvcc does not imply missing CUDA runtime libraries or a required host-driver upgrade.

Model Hub permission fix: V-Sub mounts only `<MODEL_HUB_SHARED_MODELS_PATH>/export` read-only, rather than the restricted storage root. A completed model with inaccessible or missing files is reported as a mount/permission error and never triggers a full forced re-download. Existing downloaded weights are reused after updating the package.

Local ASR/TTS models are refreshed every 30 seconds and discovered privately by V-Router using the current VOS identity. V-Sub no longer sends registration, lease renewal or unregister requests. Missing services or inactive user runtimes are normal empty discovery states.
