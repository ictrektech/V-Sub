# V-Sub __APP_VERSION__

字幕转写、翻译、校对、配音、烧录与音视频导出。保留 SmartSub 的工作流和原有模型管理，改为 VOS 浏览器入口。

从 VOS 打开应用后自动通过 OIDC Fastpath 登录，自动读取 V-Router 的 ASR/TTS 模型，包括 V-Voice 和已配置的标准云端接口。云服务凭据统一在 V-Router 管理；此应用不要求重复填写。V-Voice 的音色按所选模型读取。标准云 TTS 不提供音色列表时使用标准 OpenAI 音色，可在原服务配置中调整。

文件通过上传按钮或拖入浏览器导入；媒体、任务、模型、设置与生成文件按已验证 VOS 用户隔离。导出目录位于用户自己的应用存储中，打开导出文件时通过浏览器下载。不要在浏览器输入宿主机任意路径。

原有本地引擎和模型可以在「引擎与模型」中安装。只有安装完成且运行时可用的 ASR/TTS 模型供 V-Router 主动发现，范围为当前账户私有，每 30 秒刷新本地目录；V-Sub 不再发送主动注册、续期或注销请求。ZipVoice 在模型和用户参考音色就绪后同样私有发现；参考音频与音色不会跨账户共享。

CPU profile 使用 CPU 本地引擎；AMD CUDA、ARM CUDA、Jetson/L4T 和 Thor profile 使用 V-Voice 对应平台的专用 sherpa-onnx GPU wheel 及匹配的 CUDA / ONNX Runtime 库。L4T Paraformer 沿用 V-Voice 的 CPU 兼容回退。ARM 的 whisper.cpp 插件从上游源码构建。其他引擎是否可用以对应运行时及模型安装状态为准，不将不支持的运行时标成可用。

语言菜单提供「跟随 VOS / 简体中文 / 繁體中文 / English」。切换不刷新页面。独立打开回退浏览器语言；手动选择只写入 V-Sub 自己的浏览器存储。

## 本地模型统一管理

先安装 Model Hub，并将 `MODEL_HUB_SHARED_MODELS_PATH` 配置为与 Model Hub 相同的共享目录。V-Sub 通过 Model Hub 从 ModelScope 下载模型，缺失的兼容模型由 vivibit 仓库提供。共享权重只读挂载，删除操作只解除当前账户绑定；全局磁盘清理由 Model Hub 完成。个人音色和任务继续隔离。已有本地文件继续可用，重新下载后切换到共享权重并保留旧文件备份。

GPU 页面分别显示 sherpa-onnx 内置运行时与 whisper.cpp 可选插件。未检测到 nvcc 不表示缺少 CUDA 运行库，也不意味着必须更新宿主机驱动。

权限修复：V-Sub 只读挂载 `<MODEL_HUB_SHARED_MODELS_PATH>/export`，不再挂载整个受限存储根目录。模型下载完成后若无法读取，会明确报告目录或权限错误，不再强制重复下载。更新安装包后复用 Model Hub 中已下载的权重。
