# V-Sub API

## 两种接口和地址

VOS 模式：容器 `http://v-sub-backend:7090`，宿主机 `http://HOST:22703`，同源 `/app/com.ictrek.v-sub`。本章和侧栏 API 文档介绍 VOS HTTP、调度器绑定，以及独立桌面的 MCP/CLI，三者不是同一个鉴权端点。

桌面自动化：随包 smartsub CLI / stdio MCP 在桌面用户的机器上运行，连接本机 loopback 动态端口。桌面 `/call` 不映射到 VOS 的 7090/22703，不能把本机凭证文件或工作进程 token 当作外部公共 Key。外部应用需要语音推理时，应发现并调用 V-Scheduler 的模型接口，而非直接连接某个用户的 worker。

## VOS 身份、权限和凭证

VOS 网关按核验后的不可变用户 subject 建立私有目录和 OS UID，每个用户独立运行时。没有个人 API Key 创建/修改/查询接口；厂商配置中的 apiKey 只是上游凭证，不是 V-Sub 访问 Key。工作进程和调度器执行 token 由应用内部管理，不提供给普通外部 Agent。

- `GET /health`：公开200 `{ok,version,workers}`，只说明网关在线，不代表权重、校准或推理就绪。
- `GET /api/auth/pkce`：200 `{verifier,state,nonce,challenge}`，challenge 是 S256；完成 VOS OIDC 后用 access_token 换本应用 cookie。
- `POST /api/auth/vos-oidc`：JSON `{ "access_token": "VOS_ACCESS_TOKEN" }`，200 `{authenticated:true,user:{username,namespace}}`，设置 HttpOnly/SameSite Strict 的 `v_sub_session`，有效期1小时。写请求须符合来源校验。身份失败返回错误，不能以静态页面可见代替登录成功。
- `/api/auth/session`：200/401 返回 enabled、authenticated、clientId、scope 和可选 user；常用 GET。后续用户 HTTP/IPC 使用会话 cookie。
- `GET /api/v1/discovery`：单独接受 VOS Bearer，返回当前用户可发现的本地模型；失败401/503，不等于所有模型已校准。

```bash
BASE=http://HOST:22703
curl -c "$COOKIE_FILE" "$BASE/api/auth/vos-oidc" -H 'Content-Type: application/json' --data "{\"access_token\":\"$VOS_TOKEN\"}"
curl -b "$COOKIE_FILE" "$BASE/api/auth/session"
curl -b "$COOKIE_FILE" "$BASE/api/router"
curl -b "$COOKIE_FILE" "$BASE/api/ipc" -H 'Content-Type: application/json' --data '{"channel":"vos:runtime-status","args":[],"clientId":"example"}'
```

COOKIE_FILE 是调用方自行指定的私有 cookie 文件路径。不要记录真实 token 或完整 cookie。

## VOS HTTP 数据和事件

- `POST /api/upload?name=ENCODED_FILENAME`：原始文件字节，不是 JSON/multipart。返回200 `{path}`；文件落在当前用户 uploads 下。默认上限4GiB，可由安装参数调整。超限可能关闭请求，不承诺一定返回413；失败会删除未完成目标。
- `GET/HEAD /media?path=ABSOLUTE_PATH[&download]`：只允许用户根目录内真实文件，含 realpath/symlink 校验；返回原媒体 Content-Type、可选附件头；支持单段 Range 的206/416。
- `POST /api/ipc`：JSON `{channel:string,args:array,mode?:"invoke"|"send",clientId?:string}`；默认 invoke。返回200 `{result,downloads:[absolute-path]}`，无结果为null；特殊无操作通道可能只返回 result。参数顺序和结果沿用已注册的桌面处理器，不能向任意通道调用未注册功能。业务失败通常400 `{error:string}`，可携带调度器状态码。
- `GET /api/router`：刷新并读取网关/本地模型状态；`vos:router-status` 和 `vos:runtime-status` 是 IPC 查询通道。状态不是纯布尔可用，需要同时看模型和执行校准。
- `GET /api/events?clientId=ID`：SSE `data: {channel,args}`，15秒注释心跳；Uint8Array 编码为 `{__bytes:[0..255]}`。掉线超过15秒会销毁对应浏览器调用环境。重连后重新查询任务，不保证事件回放。
- `POST /api/dialog`：JSON `{id,paths:[absolute-path]}`，响应200 `{ok:true}`，只接受未过期的文件选择请求和用户目录内路径；对话框等待上限120秒。`POST /api/close` 的 `{clientId}` 关闭浏览器调用环境，不是删除字幕/项目，也不能代替逐任务取消。

JSON IPC 请求体上限8MiB，普通异常400；未登录401、来源错误403、未知接口404、worker代理异常502、模型/绑定不可用503。返回字节、SSE和JSON接口需要分别解析。

## 节点模型注册、预算与停止

`/api/v1/scheduler/binding` 的 GET/POST 和 `/api/v1/scheduler/discovery` 的 GET 只接受 **V-Scheduler 的 VOS application identity**，不是普通管理员用户 token。调度器自动发现、注册、校准和下发，不要求用户手工部署 agent。

绑定请求字段 protocol_version=1、正整数 binding_revision、app_id=`com.ictrek.v-sub`、可信 Scheduler url、token，以及 models（模型到 executor_id）、namespaces（64位十六进制用户空间）、model_generations（32位 worker 代次）、model_limits、model_execution_settings。每个模型必须对应本应用、task_type=model.infer、contract_version=1 且 upstream_urls 匹配的已批准 executor。缺校准/字段不符422；相同revision且内容相同可重试；旧revision或同revision内容不同409；有活动计算时不可覆盖绑定。GET/POST 成功返回 configured、protocol_version、binding_revision、approved_model_count，**不会返回绑定 token**。

私有 `/internal/scheduler/:namespace/{plan,acquire,verify,release}` 仅loopback worker使用；`/inference/:namespace/v1/*` 要求内部worker凭证与调度执行许可，不是普通用户免鉴权入口。应用报告实际停止证据后才释放资源；连接成功/请求中断不证明模型已卸载。

VOS 请求可携带任务优先级 `x-vscheduler-priority: background|interactive|high`、`x-vscheduler-preemptible`、`x-vscheduler-allow-preemption`、`x-vscheduler-force-admission`（后三者为字符串 true/false），以及 `x-vscheduler-queue-wait-seconds`（0–300整数，默认30）。应用仅转发验证后的意图，最终权限、预算与抢占由调度器决定，不因强制请求头而自动获得管理员权限。

## 桌面 MCP / CLI 和任务结果

在独立桌面安装的 MCP 设置页复制平台匹配的 CLI/MCP 配置；stdio MCP 使用随包运行时，不需要另装 Node。首次调用可启动后台；本机 endpoint.json 只对该桌面用户可读，包含动态端口与进程 token，不要发给其他用户。

本机 HTTP `GET /health` 返回 apiVersion、version、pid；`POST /call` 输入 `{operation,args}`，成功200 `{ok:true,result}`，失败400 `{ok:false,error:{code,message}}`。要求127.0.0.1 Host、无Origin且正确Bearer，失败401；请求体8MiB上限。MCP 工具名由操作名映射，结果位于 structuredContent.result，错误检查 isError；它不是VOS公开HTTP接口。

异步操作返回持久化任务ID。任务对象字段 id、operation、status、createdAt/updatedAt（毫秒时间戳）、requestId、fingerprint、projectId、progress、result、error `{code,message,details}`、artifacts `[{kind,path}]`、actions。状态 queued/running/paused/review/cancelling/completed/failed/cancelled/interrupted；review 不是完成，人工流程需要明确 release。tasks.get/tasks.wait 查询，wait最多25秒，超时不取消；tasks.cancel 仅取消指定任务及子进程，pause只暂停后续分发。断开 MCP 不会自动取消任务。重试同一提交时复用 requestId，参数改变要使用新ID。

providers.types 先发现字段和能力，providers.save 的 `{kind,provider}` 按ID新增/增量修改，省略秘密保留，读取只返回脱敏信息；providers.test 会真实请求上游，可能计费。没有从此接口获取 V-Scheduler 访问 Key 的功能。models.install/delete 是权重安装/删除，不等于卸载已运行模型或停止所有任务。下面111项操作的原生输入 schema、CLI/MCP 名称及同步/异步属性与应用共用同一生成目录。

## system.info

Application version, platform, profile, engine runtime paths (e.g. faster-whisper python runtime and binaries), storage topology (userData, storageRoot, temp, logs, models), installed models, hardware environment, providers, and architecture notes.

- CLI：`smartsub system info`
- MCP：`smartsub_system_info`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## system.capabilities

List all operations and whether they are read-only or asynchronous.

- CLI：`smartsub system capabilities`
- MCP：`smartsub_system_capabilities`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## system.logs

Read redacted application logs.

- CLI：`smartsub system logs`
- MCP：`smartsub_system_logs`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "minLength": 1
    },
    "date": {
      "type": "string",
      "minLength": 1
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500,
      "default": 100
    },
    "types": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["info", "warning", "error"]
      },
      "maxItems": 3,
      "description": "Filter by log level. Use [\"error\", \"warning\"] to diagnose failures quickly."
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## system.languages

Supported language codes.

- CLI：`smartsub system languages`
- MCP：`smartsub_system_languages`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## system.sample

Absolute path of the bundled sample audio.

- CLI：`smartsub system sample`
- MCP：`smartsub_system_sample`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.list

List recent desktop and automation jobs.

- CLI：`smartsub tasks list`
- MCP：`smartsub_tasks_list`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "default": 50
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.get

Get status, progress, error, result and output paths. Poll until a terminal status.

- CLI：`smartsub tasks get`
- MCP：`smartsub_tasks_get`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.wait

Wait up to 25 seconds for a terminal or review state. Timeout never cancels a job.

- CLI：`smartsub tasks wait`
- MCP：`smartsub_tasks_wait`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 25000,
      "default": 25000
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.cancel

Cancel only the specified job and its active child process.

- CLI：`smartsub tasks cancel`
- MCP：`smartsub_tasks_cancel`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.pause

Pause dispatch of additional files in a pipeline; active files may finish.

- CLI：`smartsub tasks pause`
- MCP：`smartsub_tasks_pause`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.resume

Resume a paused pipeline.

- CLI：`smartsub tasks resume`
- MCP：`smartsub_tasks_resume`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.retry

Retry interrupted or failed pipeline files using the saved execution settings.

- CLI：`smartsub tasks retry`
- MCP：`smartsub_tasks_retry`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tasks.delete

Delete a completed task record; does not delete input media.

- CLI：`smartsub tasks delete`
- MCP：`smartsub_tasks_delete`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## transcribe

Generate original-language subtitles using an installed local ASR engine or configured cloud ASR provider. AI segmentation/correction is opt-in and requires config.refineProvider. Inspect settings.get, engines.list, models.list and providers.list before selecting resources. Returns a job ID.

- CLI：`smartsub transcribe`
- MCP：`smartsub_transcribe`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "description": "Absolute local file or directory path on the SmartSub host."
      },
      "minItems": 1,
      "maxItems": 1000
    },
    "engine": {
      "type": "string",
      "enum": [
        "builtin",
        "fasterWhisper",
        "funasr",
        "qwen",
        "fireRedAsr",
        "parakeet",
        "localCli",
        "cloud"
      ]
    },
    "model": {
      "type": "string",
      "minLength": 1
    },
    "sourceLanguage": {
      "type": "string",
      "minLength": 1
    },
    "targetLanguage": {
      "type": "string",
      "minLength": 1
    },
    "providerId": {
      "type": "string",
      "minLength": 1,
      "description": "For transcribe: cloud ASR provider ID (requires engine=\"cloud\"). For translate/pipeline.run: translation provider ID. Use config.asrProviderId and config.translateProvider for pipelines that need both; use config.refineProvider for AI segmentation/correction."
    },
    "outputDir": {
      "type": "string",
      "minLength": 1,
      "description": "Defaults to a new directory per task under the profile automation outputs directory."
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    },
    "config": {
      "type": "object",
      "properties": {
        "dub": {
          "type": "object",
          "properties": {
            "engine": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "local"
                    },
                    "modelId": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": ["kind", "modelId"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "cloud"
                    },
                    "providerId": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": ["kind", "providerId"],
                  "additionalProperties": false
                }
              ]
            },
            "voice": {
              "type": "string",
              "minLength": 1
            },
            "language": {
              "type": "string",
              "minLength": 1
            },
            "globalSpeed": {
              "type": "number",
              "minimum": 0.5,
              "maximum": 2,
              "default": 1
            },
            "cloneQuality": {
              "type": "string",
              "enum": ["standard", "high"]
            },
            "localConcurrency": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "overflow": {
              "type": "string",
              "enum": ["truncate", "shift"]
            },
            "overlapMode": {
              "type": "string",
              "enum": ["shift", "mix"]
            }
          },
          "required": ["engine", "voice"],
          "additionalProperties": false,
          "description": "Opt-in dubbing. Use models.list for local TTS or providers.list(kind=\"tts\") for cloud; choose a compatible voice with tts.voices or voices.list. Chat and ASR services cannot provide TTS."
        },
        "compose": {
          "type": "object",
          "properties": {
            "subtitle": {
              "type": "string",
              "enum": ["hard", "soft", "none"]
            },
            "style": {
              "type": "object",
              "properties": {
                "fontName": {
                  "type": "string",
                  "minLength": 1
                },
                "fontSize": {
                  "type": "number",
                  "minimum": 10,
                  "maximum": 72
                },
                "primaryColor": {
                  "type": "string",
                  "minLength": 1
                },
                "outlineColor": {
                  "type": "string",
                  "minLength": 1
                },
                "backColor": {
                  "type": "string",
                  "minLength": 1
                },
                "backOpacity": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                },
                "bold": {
                  "type": "boolean"
                },
                "italic": {
                  "type": "boolean"
                },
                "underline": {
                  "type": "boolean"
                },
                "borderStyle": {
                  "type": "number",
                  "enum": [1, 3]
                },
                "outline": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "shadow": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "alignment": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9
                },
                "marginL": {
                  "type": "number",
                  "minimum": 0
                },
                "marginR": {
                  "type": "number",
                  "minimum": 0
                },
                "marginV": {
                  "type": "number",
                  "minimum": 0
                },
                "positionY": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                },
                "secondLineColor": {
                  "type": "string",
                  "minLength": 1
                },
                "highlightTerms": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "highlightColor": {
                  "type": "string",
                  "minLength": 1
                },
                "glow": {
                  "type": "number",
                  "minimum": 0
                },
                "glowColor": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "additionalProperties": true
            },
            "styleId": {
              "type": "string",
              "minLength": 1
            },
            "styleName": {
              "type": "string",
              "minLength": 1
            },
            "videoQuality": {
              "type": "string",
              "enum": ["original", "high", "standard"]
            },
            "encoderMode": {
              "type": "string",
              "enum": ["cpu", "hardware"]
            }
          },
          "required": ["subtitle"],
          "additionalProperties": false
        },
        "gates": {
          "type": "object",
          "properties": {
            "subtitle": {
              "type": "string",
              "enum": ["auto", "manual"],
              "default": "auto"
            },
            "dubbing": {
              "type": "string",
              "enum": ["auto", "manual"],
              "default": "auto"
            }
          },
          "additionalProperties": false
        },
        "asrProviderId": {
          "type": "string",
          "minLength": 1,
          "description": "Cloud ASR provider ID from providers.list(kind=\"asr\"). Requires engine=\"cloud\" and a model in that provider's models list. Independent from translation/refinement/chat."
        },
        "translateProvider": {
          "type": "string",
          "minLength": 1,
          "description": "Translation provider ID from providers.list(kind=\"translation\"). Required for translate and translating pipelines; \"-1\" is not a valid translation selection."
        },
        "useEmbeddedSubtitles": {
          "type": "boolean"
        },
        "translateContent": {
          "type": "string",
          "enum": ["onlyTranslate", "sourceAndTranslate", "translateAndSource"]
        },
        "subtitleOutputFormats": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["srt", "vtt", "ass", "lrc", "txt"]
          },
          "minItems": 1
        },
        "subtitleLayout": {
          "type": "string",
          "enum": ["original", "two-line"]
        },
        "subtitleLineWidth": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "maxSubtitleChars": {
          "type": "number",
          "minimum": -1
        },
        "subtitleMaxDuration": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "subtitleMaxGap": {
          "type": "number",
          "minimum": 0
        },
        "preserveSpeechPauses": {
          "type": "boolean",
          "description": "Preserve speech gaps during subtitle segmentation. Does not require an AI provider by itself."
        },
        "aiSegmentation": {
          "type": "boolean",
          "description": "Opt-in AI semantic segmentation of ASR output. Defaults to false for automation. Requires a configured AI refineProvider; do not enable just to generate original SRT."
        },
        "aiCorrection": {
          "type": "boolean",
          "description": "Opt-in AI correction of ASR text. Defaults to false for automation. Requires a configured AI refineProvider."
        },
        "refineProvider": {
          "type": "string",
          "minLength": 1,
          "description": "AI provider ID from providers.list(kind=\"translation\") with isAi=true and configured=true. Required for AI segmentation/correction. Omitted or \"follow-translation\" uses the task translation provider. The in-app assistant can use its current AI service when omitted and no task service resolves. Explicit selections are never replaced."
        },
        "subtitleTranslationStyle": {
          "type": "string",
          "enum": ["neutral", "conversational"],
          "description": "Defaults to neutral. Conversational style requires a configured AI translation provider, including translate-only tasks."
        },
        "speakerDiarization": {
          "type": "boolean",
          "description": "Opt-in speaker identification for media. Requires installed speaker models and Sherpa runtime; inspect models.list before enabling."
        },
        "speakerDiarizationCount": {
          "type": "integer",
          "minimum": 0,
          "maximum": 8
        },
        "speakerDiarizationEmbedInSubtitle": {
          "type": "boolean"
        },
        "manuscriptPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "additionalProperties": true,
      "description": "Task overrides. Optional refinement, speaker identification, dubbing, composition and manuscript inputs are disabled unless explicitly supplied. Engine/model/provider preferences come from settings.get.defaults. Pass the desired task/recipe config here to reuse its advanced stages."
    }
  },
  "required": ["files"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## translate

Translate subtitle files using a configured translation provider and explicit targetLanguage. A missing provider is an error; translation is never silently skipped. Conversational style requires an AI provider. Returns a job ID.

- CLI：`smartsub translate`
- MCP：`smartsub_translate`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "description": "Absolute local file or directory path on the SmartSub host."
      },
      "minItems": 1,
      "maxItems": 1000
    },
    "engine": {
      "type": "string",
      "enum": [
        "builtin",
        "fasterWhisper",
        "funasr",
        "qwen",
        "fireRedAsr",
        "parakeet",
        "localCli",
        "cloud"
      ]
    },
    "model": {
      "type": "string",
      "minLength": 1
    },
    "sourceLanguage": {
      "type": "string",
      "minLength": 1
    },
    "targetLanguage": {
      "type": "string",
      "minLength": 1
    },
    "providerId": {
      "type": "string",
      "minLength": 1,
      "description": "For transcribe: cloud ASR provider ID (requires engine=\"cloud\"). For translate/pipeline.run: translation provider ID. Use config.asrProviderId and config.translateProvider for pipelines that need both; use config.refineProvider for AI segmentation/correction."
    },
    "outputDir": {
      "type": "string",
      "minLength": 1,
      "description": "Defaults to a new directory per task under the profile automation outputs directory."
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    },
    "config": {
      "type": "object",
      "properties": {
        "dub": {
          "type": "object",
          "properties": {
            "engine": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "local"
                    },
                    "modelId": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": ["kind", "modelId"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "cloud"
                    },
                    "providerId": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": ["kind", "providerId"],
                  "additionalProperties": false
                }
              ]
            },
            "voice": {
              "type": "string",
              "minLength": 1
            },
            "language": {
              "type": "string",
              "minLength": 1
            },
            "globalSpeed": {
              "type": "number",
              "minimum": 0.5,
              "maximum": 2,
              "default": 1
            },
            "cloneQuality": {
              "type": "string",
              "enum": ["standard", "high"]
            },
            "localConcurrency": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "overflow": {
              "type": "string",
              "enum": ["truncate", "shift"]
            },
            "overlapMode": {
              "type": "string",
              "enum": ["shift", "mix"]
            }
          },
          "required": ["engine", "voice"],
          "additionalProperties": false,
          "description": "Opt-in dubbing. Use models.list for local TTS or providers.list(kind=\"tts\") for cloud; choose a compatible voice with tts.voices or voices.list. Chat and ASR services cannot provide TTS."
        },
        "compose": {
          "type": "object",
          "properties": {
            "subtitle": {
              "type": "string",
              "enum": ["hard", "soft", "none"]
            },
            "style": {
              "type": "object",
              "properties": {
                "fontName": {
                  "type": "string",
                  "minLength": 1
                },
                "fontSize": {
                  "type": "number",
                  "minimum": 10,
                  "maximum": 72
                },
                "primaryColor": {
                  "type": "string",
                  "minLength": 1
                },
                "outlineColor": {
                  "type": "string",
                  "minLength": 1
                },
                "backColor": {
                  "type": "string",
                  "minLength": 1
                },
                "backOpacity": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                },
                "bold": {
                  "type": "boolean"
                },
                "italic": {
                  "type": "boolean"
                },
                "underline": {
                  "type": "boolean"
                },
                "borderStyle": {
                  "type": "number",
                  "enum": [1, 3]
                },
                "outline": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "shadow": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "alignment": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9
                },
                "marginL": {
                  "type": "number",
                  "minimum": 0
                },
                "marginR": {
                  "type": "number",
                  "minimum": 0
                },
                "marginV": {
                  "type": "number",
                  "minimum": 0
                },
                "positionY": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                },
                "secondLineColor": {
                  "type": "string",
                  "minLength": 1
                },
                "highlightTerms": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "highlightColor": {
                  "type": "string",
                  "minLength": 1
                },
                "glow": {
                  "type": "number",
                  "minimum": 0
                },
                "glowColor": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "additionalProperties": true
            },
            "styleId": {
              "type": "string",
              "minLength": 1
            },
            "styleName": {
              "type": "string",
              "minLength": 1
            },
            "videoQuality": {
              "type": "string",
              "enum": ["original", "high", "standard"]
            },
            "encoderMode": {
              "type": "string",
              "enum": ["cpu", "hardware"]
            }
          },
          "required": ["subtitle"],
          "additionalProperties": false
        },
        "gates": {
          "type": "object",
          "properties": {
            "subtitle": {
              "type": "string",
              "enum": ["auto", "manual"],
              "default": "auto"
            },
            "dubbing": {
              "type": "string",
              "enum": ["auto", "manual"],
              "default": "auto"
            }
          },
          "additionalProperties": false
        },
        "asrProviderId": {
          "type": "string",
          "minLength": 1,
          "description": "Cloud ASR provider ID from providers.list(kind=\"asr\"). Requires engine=\"cloud\" and a model in that provider's models list. Independent from translation/refinement/chat."
        },
        "translateProvider": {
          "type": "string",
          "minLength": 1,
          "description": "Translation provider ID from providers.list(kind=\"translation\"). Required for translate and translating pipelines; \"-1\" is not a valid translation selection."
        },
        "useEmbeddedSubtitles": {
          "type": "boolean"
        },
        "translateContent": {
          "type": "string",
          "enum": ["onlyTranslate", "sourceAndTranslate", "translateAndSource"]
        },
        "subtitleOutputFormats": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["srt", "vtt", "ass", "lrc", "txt"]
          },
          "minItems": 1
        },
        "subtitleLayout": {
          "type": "string",
          "enum": ["original", "two-line"]
        },
        "subtitleLineWidth": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "maxSubtitleChars": {
          "type": "number",
          "minimum": -1
        },
        "subtitleMaxDuration": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "subtitleMaxGap": {
          "type": "number",
          "minimum": 0
        },
        "preserveSpeechPauses": {
          "type": "boolean",
          "description": "Preserve speech gaps during subtitle segmentation. Does not require an AI provider by itself."
        },
        "aiSegmentation": {
          "type": "boolean",
          "description": "Opt-in AI semantic segmentation of ASR output. Defaults to false for automation. Requires a configured AI refineProvider; do not enable just to generate original SRT."
        },
        "aiCorrection": {
          "type": "boolean",
          "description": "Opt-in AI correction of ASR text. Defaults to false for automation. Requires a configured AI refineProvider."
        },
        "refineProvider": {
          "type": "string",
          "minLength": 1,
          "description": "AI provider ID from providers.list(kind=\"translation\") with isAi=true and configured=true. Required for AI segmentation/correction. Omitted or \"follow-translation\" uses the task translation provider. The in-app assistant can use its current AI service when omitted and no task service resolves. Explicit selections are never replaced."
        },
        "subtitleTranslationStyle": {
          "type": "string",
          "enum": ["neutral", "conversational"],
          "description": "Defaults to neutral. Conversational style requires a configured AI translation provider, including translate-only tasks."
        },
        "speakerDiarization": {
          "type": "boolean",
          "description": "Opt-in speaker identification for media. Requires installed speaker models and Sherpa runtime; inspect models.list before enabling."
        },
        "speakerDiarizationCount": {
          "type": "integer",
          "minimum": 0,
          "maximum": 8
        },
        "speakerDiarizationEmbedInSubtitle": {
          "type": "boolean"
        },
        "manuscriptPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "additionalProperties": true,
      "description": "Task overrides. Optional refinement, speaker identification, dubbing, composition and manuscript inputs are disabled unless explicitly supplied. Engine/model/provider preferences come from settings.get.defaults. Pass the desired task/recipe config here to reuse its advanced stages."
    }
  },
  "required": ["files", "targetLanguage"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## pipeline.run

Run transcription/translation with opt-in AI refinement, speaker identification, dubbing and video composition. Select ASR, translation/refinement and TTS providers separately. Pass desired advanced stages in config; default review gates are automatic.

- CLI：`smartsub pipeline run`
- MCP：`smartsub_pipeline_run`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "description": "Absolute local file or directory path on the SmartSub host."
      },
      "minItems": 1,
      "maxItems": 1000
    },
    "engine": {
      "type": "string",
      "enum": [
        "builtin",
        "fasterWhisper",
        "funasr",
        "qwen",
        "fireRedAsr",
        "parakeet",
        "localCli",
        "cloud"
      ]
    },
    "model": {
      "type": "string",
      "minLength": 1
    },
    "sourceLanguage": {
      "type": "string",
      "minLength": 1
    },
    "targetLanguage": {
      "type": "string",
      "minLength": 1
    },
    "providerId": {
      "type": "string",
      "minLength": 1,
      "description": "For transcribe: cloud ASR provider ID (requires engine=\"cloud\"). For translate/pipeline.run: translation provider ID. Use config.asrProviderId and config.translateProvider for pipelines that need both; use config.refineProvider for AI segmentation/correction."
    },
    "outputDir": {
      "type": "string",
      "minLength": 1,
      "description": "Defaults to a new directory per task under the profile automation outputs directory."
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    },
    "config": {
      "type": "object",
      "properties": {
        "dub": {
          "type": "object",
          "properties": {
            "engine": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "local"
                    },
                    "modelId": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": ["kind", "modelId"],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "cloud"
                    },
                    "providerId": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": ["kind", "providerId"],
                  "additionalProperties": false
                }
              ]
            },
            "voice": {
              "type": "string",
              "minLength": 1
            },
            "language": {
              "type": "string",
              "minLength": 1
            },
            "globalSpeed": {
              "type": "number",
              "minimum": 0.5,
              "maximum": 2,
              "default": 1
            },
            "cloneQuality": {
              "type": "string",
              "enum": ["standard", "high"]
            },
            "localConcurrency": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            },
            "overflow": {
              "type": "string",
              "enum": ["truncate", "shift"]
            },
            "overlapMode": {
              "type": "string",
              "enum": ["shift", "mix"]
            }
          },
          "required": ["engine", "voice"],
          "additionalProperties": false,
          "description": "Opt-in dubbing. Use models.list for local TTS or providers.list(kind=\"tts\") for cloud; choose a compatible voice with tts.voices or voices.list. Chat and ASR services cannot provide TTS."
        },
        "compose": {
          "type": "object",
          "properties": {
            "subtitle": {
              "type": "string",
              "enum": ["hard", "soft", "none"]
            },
            "style": {
              "type": "object",
              "properties": {
                "fontName": {
                  "type": "string",
                  "minLength": 1
                },
                "fontSize": {
                  "type": "number",
                  "minimum": 10,
                  "maximum": 72
                },
                "primaryColor": {
                  "type": "string",
                  "minLength": 1
                },
                "outlineColor": {
                  "type": "string",
                  "minLength": 1
                },
                "backColor": {
                  "type": "string",
                  "minLength": 1
                },
                "backOpacity": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                },
                "bold": {
                  "type": "boolean"
                },
                "italic": {
                  "type": "boolean"
                },
                "underline": {
                  "type": "boolean"
                },
                "borderStyle": {
                  "type": "number",
                  "enum": [1, 3]
                },
                "outline": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "shadow": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "alignment": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9
                },
                "marginL": {
                  "type": "number",
                  "minimum": 0
                },
                "marginR": {
                  "type": "number",
                  "minimum": 0
                },
                "marginV": {
                  "type": "number",
                  "minimum": 0
                },
                "positionY": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                },
                "secondLineColor": {
                  "type": "string",
                  "minLength": 1
                },
                "highlightTerms": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "highlightColor": {
                  "type": "string",
                  "minLength": 1
                },
                "glow": {
                  "type": "number",
                  "minimum": 0
                },
                "glowColor": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "additionalProperties": true
            },
            "styleId": {
              "type": "string",
              "minLength": 1
            },
            "styleName": {
              "type": "string",
              "minLength": 1
            },
            "videoQuality": {
              "type": "string",
              "enum": ["original", "high", "standard"]
            },
            "encoderMode": {
              "type": "string",
              "enum": ["cpu", "hardware"]
            }
          },
          "required": ["subtitle"],
          "additionalProperties": false
        },
        "gates": {
          "type": "object",
          "properties": {
            "subtitle": {
              "type": "string",
              "enum": ["auto", "manual"],
              "default": "auto"
            },
            "dubbing": {
              "type": "string",
              "enum": ["auto", "manual"],
              "default": "auto"
            }
          },
          "additionalProperties": false
        },
        "asrProviderId": {
          "type": "string",
          "minLength": 1,
          "description": "Cloud ASR provider ID from providers.list(kind=\"asr\"). Requires engine=\"cloud\" and a model in that provider's models list. Independent from translation/refinement/chat."
        },
        "translateProvider": {
          "type": "string",
          "minLength": 1,
          "description": "Translation provider ID from providers.list(kind=\"translation\"). Required for translate and translating pipelines; \"-1\" is not a valid translation selection."
        },
        "useEmbeddedSubtitles": {
          "type": "boolean"
        },
        "translateContent": {
          "type": "string",
          "enum": ["onlyTranslate", "sourceAndTranslate", "translateAndSource"]
        },
        "subtitleOutputFormats": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["srt", "vtt", "ass", "lrc", "txt"]
          },
          "minItems": 1
        },
        "subtitleLayout": {
          "type": "string",
          "enum": ["original", "two-line"]
        },
        "subtitleLineWidth": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "maxSubtitleChars": {
          "type": "number",
          "minimum": -1
        },
        "subtitleMaxDuration": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "subtitleMaxGap": {
          "type": "number",
          "minimum": 0
        },
        "preserveSpeechPauses": {
          "type": "boolean",
          "description": "Preserve speech gaps during subtitle segmentation. Does not require an AI provider by itself."
        },
        "aiSegmentation": {
          "type": "boolean",
          "description": "Opt-in AI semantic segmentation of ASR output. Defaults to false for automation. Requires a configured AI refineProvider; do not enable just to generate original SRT."
        },
        "aiCorrection": {
          "type": "boolean",
          "description": "Opt-in AI correction of ASR text. Defaults to false for automation. Requires a configured AI refineProvider."
        },
        "refineProvider": {
          "type": "string",
          "minLength": 1,
          "description": "AI provider ID from providers.list(kind=\"translation\") with isAi=true and configured=true. Required for AI segmentation/correction. Omitted or \"follow-translation\" uses the task translation provider. The in-app assistant can use its current AI service when omitted and no task service resolves. Explicit selections are never replaced."
        },
        "subtitleTranslationStyle": {
          "type": "string",
          "enum": ["neutral", "conversational"],
          "description": "Defaults to neutral. Conversational style requires a configured AI translation provider, including translate-only tasks."
        },
        "speakerDiarization": {
          "type": "boolean",
          "description": "Opt-in speaker identification for media. Requires installed speaker models and Sherpa runtime; inspect models.list before enabling."
        },
        "speakerDiarizationCount": {
          "type": "integer",
          "minimum": 0,
          "maximum": 8
        },
        "speakerDiarizationEmbedInSubtitle": {
          "type": "boolean"
        },
        "manuscriptPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "additionalProperties": true,
      "description": "Task overrides. Optional refinement, speaker identification, dubbing, composition and manuscript inputs are disabled unless explicitly supplied. Engine/model/provider preferences come from settings.get.defaults. Pass the desired task/recipe config here to reuse its advanced stages."
    },
    "taskType": {
      "type": "string",
      "enum": ["generateOnly", "translateOnly", "generateAndTranslate"],
      "default": "generateAndTranslate"
    }
  },
  "required": ["files"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## pipeline.release

Release a subtitle or dubbing review gate.

- CLI：`smartsub pipeline release`
- MCP：`smartsub_pipeline_release`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "minLength": 1
    },
    "gate": {
      "type": "string",
      "enum": ["subtitle", "dubbing"]
    },
    "fileUuids": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "required": ["projectId", "gate"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.read

Read subtitle cues with a content version for safe editing. Paginated; times are milliseconds.

- CLI：`smartsub subtitles read`
- MCP：`smartsub_subtitles_read`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "default": 0
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500,
      "default": 100
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.write

Write subtitle cues to a new file. In-place changes require overwrite=true and the version returned by subtitles.read.

- CLI：`smartsub subtitles write`
- MCP：`smartsub_subtitles_write`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "cues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "startMs": {
            "type": "number",
            "minimum": 0
          },
          "endMs": {
            "type": "number",
            "minimum": 0
          },
          "text": {
            "type": "string"
          }
        },
        "required": ["startMs", "endMs", "text"],
        "additionalProperties": false
      },
      "minItems": 1
    },
    "format": {
      "type": "string",
      "enum": ["srt", "vtt", "ass", "lrc", "txt"]
    },
    "overwrite": {
      "type": "boolean",
      "default": false
    },
    "expectedVersion": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["filePath", "cues"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.validate

Validate a subtitle file.

- CLI：`smartsub subtitles validate`
- MCP：`smartsub_subtitles_validate`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.detect-language

Detect subtitle language.

- CLI：`smartsub subtitles detect-language`
- MCP：`smartsub_subtitles_detect_language`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.scan

Find subtitle/media pairs in a local directory.

- CLI：`smartsub subtitles scan`
- MCP：`smartsub_subtitles_scan`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "directoryPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "strict": {
      "type": "boolean"
    }
  },
  "required": ["directoryPath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.encoding

Detect subtitle character encoding.

- CLI：`smartsub subtitles encoding`
- MCP：`smartsub_subtitles_encoding`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.convert

Convert subtitle format, encoding and Chinese script without overwriting input.

- CLI：`smartsub subtitles convert`
- MCP：`smartsub_subtitles_convert`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "targetFormat": {
      "type": "string",
      "enum": ["srt", "vtt", "ass", "lrc", "txt"]
    },
    "outputDir": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "sourceEncoding": {
      "type": "string",
      "minLength": 1
    },
    "targetEncoding": {
      "type": "string",
      "enum": ["utf-8", "utf-8-bom", "gb18030"]
    },
    "chineseConversion": {
      "type": "string",
      "enum": ["none", "s2t", "t2s", "s2tw", "tw2s", "s2hk", "hk2s"]
    },
    "cleanFormatting": {
      "type": "boolean"
    },
    "includeTimestampsInTxt": {
      "type": "boolean"
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["filePath", "targetFormat"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.sync

Shift or rescale subtitle timings.

- CLI：`smartsub subtitles sync`
- MCP：`smartsub_subtitles_sync`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "offsetMs": {
      "type": "number"
    },
    "config": {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "enum": ["offset", "scale", "two-point"],
          "default": "offset"
        },
        "offsetMs": {
          "type": "number"
        },
        "scaleRatio": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "scaleFraction": {
          "type": "object",
          "properties": {
            "numerator": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "denominator": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          },
          "required": ["numerator", "denominator"],
          "additionalProperties": false
        },
        "p1SourceMs": {
          "type": "number",
          "minimum": 0
        },
        "p1TargetMs": {
          "type": "number",
          "minimum": 0
        },
        "p2SourceMs": {
          "type": "number",
          "minimum": 0
        },
        "p2TargetMs": {
          "type": "number",
          "minimum": 0
        },
        "outputPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "additionalProperties": false,
      "default": {}
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.merge

Merge primary and secondary subtitle files into bilingual subtitles.

- CLI：`smartsub subtitles merge`
- MCP：`smartsub_subtitles_merge`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "primaryPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "secondaryPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "config": {
      "type": "object",
      "properties": {
        "primaryPosition": {
          "type": "string",
          "enum": ["top", "bottom"],
          "default": "top"
        },
        "separator": {
          "type": "string"
        },
        "outputPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "additionalProperties": false,
      "default": {}
    }
  },
  "required": ["primaryPath", "secondaryPath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.split

Split bilingual subtitles.

- CLI：`smartsub subtitles split`
- MCP：`smartsub_subtitles_split`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "config": {
      "type": "object",
      "properties": {
        "outputDir": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "additionalProperties": false,
      "default": {}
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.optimize

Polish one source or translated subtitle using a configured AI provider.

- CLI：`smartsub subtitles optimize`
- MCP：`smartsub_subtitles_optimize`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "sourceText": {
      "type": "string"
    },
    "targetText": {
      "type": "string",
      "default": ""
    },
    "providerId": {
      "type": "string",
      "minLength": 1
    },
    "mode": {
      "type": "string",
      "enum": ["source", "translation"],
      "default": "translation"
    },
    "sourceLanguage": {
      "type": "string",
      "minLength": 1
    },
    "targetLanguage": {
      "type": "string",
      "minLength": 1
    },
    "customPrompt": {
      "type": "string",
      "minLength": 1
    },
    "intent": {
      "type": "string",
      "enum": ["polish", "correct", "shorten"]
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["sourceText", "providerId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## subtitles.retranslate

Retranslate subtitle rows using an existing provider. Results are returned in the job result.

- CLI：`smartsub subtitles retranslate`
- MCP：`smartsub_subtitles_retranslate`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "subtitles": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "startEndTime": {
            "type": "string",
            "minLength": 1
          },
          "content": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": ["id", "startEndTime", "content"],
        "additionalProperties": false
      }
    },
    "providerId": {
      "type": "string",
      "minLength": 1
    },
    "sourceLanguage": {
      "type": "string",
      "minLength": 1
    },
    "targetLanguage": {
      "type": "string",
      "minLength": 1
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["subtitles", "providerId", "sourceLanguage", "targetLanguage"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## proofread.read

Read canonical proofread data including speakers and translations.

- CLI：`smartsub proofread read`
- MCP：`smartsub_proofread_read`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## proofread.save

Save canonical proofread rows, speakers and rendered subtitles with conflict checking.

- CLI：`smartsub proofread save`
- MCP：`smartsub_proofread_save`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "expectedVersion": {
      "type": "string",
      "minLength": 1
    },
    "subtitles": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": {}
      }
    },
    "speakers": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": {}
      },
      "default": []
    },
    "outputs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "minLength": 1,
            "description": "Absolute local file or directory path on the SmartSub host."
          },
          "contentType": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": ["filePath"],
        "additionalProperties": false
      },
      "default": []
    },
    "embedSpeakerNames": {
      "type": "boolean",
      "default": false
    }
  },
  "required": ["filePath", "expectedVersion", "subtitles"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## media.probe

Inspect media duration, dimensions, streams and codecs.

- CLI：`smartsub media probe`
- MCP：`smartsub_media_probe`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## media.subtitles

List embedded subtitle tracks.

- CLI：`smartsub media subtitles`
- MCP：`smartsub_media_subtitles`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["filePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## media.trim

Trim a video. config: startSec,endSec,mode (lossless|accurate),outputPath/outputDir.

- CLI：`smartsub media trim`
- MCP：`smartsub_media_trim`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "config": {
      "type": "object",
      "properties": {
        "startSec": {
          "type": "number",
          "minimum": 0
        },
        "endSec": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "mode": {
          "type": "string",
          "enum": ["lossless", "accurate"],
          "default": "lossless"
        },
        "outputPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        },
        "outputDir": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "required": ["startSec", "endSec"],
      "additionalProperties": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["filePath", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## media.extract-audio

Extract audio. config: format (mp3|wav|aac|m4a|flac),bitrate,wavPreset,outputPath.

- CLI：`smartsub media extract-audio`
- MCP：`smartsub_media_extract_audio`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "config": {
      "type": "object",
      "properties": {
        "format": {
          "type": "string",
          "enum": ["mp3", "wav", "aac", "m4a", "flac"]
        },
        "bitrate": {
          "type": "string",
          "enum": ["128k", "192k", "256k", "320k"]
        },
        "wavPreset": {
          "type": "string",
          "enum": ["standard", "asr_16k_mono"]
        },
        "outputPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "required": ["format"],
      "additionalProperties": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["filePath", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## media.compress

Compress video. Use the VideoCompressConfig fields.

- CLI：`smartsub media compress`
- MCP：`smartsub_media_compress`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "config": {
      "type": "object",
      "properties": {
        "preset": {
          "type": "string",
          "enum": ["wechat_25mb", "balanced_1080p", "fast_720p", "target_size"]
        },
        "targetSizeMb": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "outputPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "required": ["preset"],
      "additionalProperties": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["filePath", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## media.gif

Convert video to GIF. Use the VideoToGifConfig fields.

- CLI：`smartsub media gif`
- MCP：`smartsub_media_gif`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "config": {
      "type": "object",
      "properties": {
        "startSec": {
          "type": "number",
          "minimum": 0
        },
        "endSec": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "fps": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "outputPath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        }
      },
      "required": ["startSec", "endSec"],
      "additionalProperties": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["filePath", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## media.extract-subtitles

Extract embedded text subtitles to files.

- CLI：`smartsub media extract-subtitles`
- MCP：`smartsub_media_extract_subtitles`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "videoPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "streamIndices": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 0
      },
      "minItems": 1
    },
    "targetFormat": {
      "type": "string",
      "enum": ["srt", "ass", "vtt"]
    },
    "outputDir": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["videoPath", "streamIndices", "targetFormat"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## compose.run

Burn or mux subtitles into video. config uses MergeConfig: outputMode hardcode/softmux, style, videoQuality, encoderMode and optional audioTrack.

- CLI：`smartsub compose run`
- MCP：`smartsub_compose_run`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "videoPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "subtitlePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "outputPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "config": {
      "type": "object",
      "properties": {
        "outputMode": {
          "type": "string",
          "enum": ["hardcode", "softmux"],
          "default": "hardcode"
        },
        "videoQuality": {
          "type": "string",
          "enum": ["original", "high", "standard"]
        },
        "encoderMode": {
          "type": "string",
          "enum": ["cpu", "hardware"]
        },
        "style": {
          "type": "object",
          "properties": {
            "fontName": {
              "type": "string",
              "minLength": 1
            },
            "fontSize": {
              "type": "number",
              "minimum": 10,
              "maximum": 72
            },
            "primaryColor": {
              "type": "string",
              "minLength": 1
            },
            "outlineColor": {
              "type": "string",
              "minLength": 1
            },
            "backColor": {
              "type": "string",
              "minLength": 1
            },
            "backOpacity": {
              "type": "number",
              "minimum": 0,
              "maximum": 100
            },
            "bold": {
              "type": "boolean"
            },
            "italic": {
              "type": "boolean"
            },
            "underline": {
              "type": "boolean"
            },
            "borderStyle": {
              "type": "number",
              "enum": [1, 3]
            },
            "outline": {
              "type": "number",
              "minimum": 0,
              "maximum": 10
            },
            "shadow": {
              "type": "number",
              "minimum": 0,
              "maximum": 10
            },
            "alignment": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9
            },
            "marginL": {
              "type": "number",
              "minimum": 0
            },
            "marginR": {
              "type": "number",
              "minimum": 0
            },
            "marginV": {
              "type": "number",
              "minimum": 0
            },
            "positionY": {
              "type": "number",
              "minimum": 0,
              "maximum": 100
            },
            "secondLineColor": {
              "type": "string",
              "minLength": 1
            },
            "highlightTerms": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1
              }
            },
            "highlightColor": {
              "type": "string",
              "minLength": 1
            },
            "glow": {
              "type": "number",
              "minimum": 0
            },
            "glowColor": {
              "type": "string",
              "minLength": 1
            }
          },
          "additionalProperties": true
        },
        "audioTrack": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": ["replace", "mix", "addTrack"]
            },
            "trackPath": {
              "type": "string",
              "minLength": 1,
              "description": "Absolute local file or directory path on the SmartSub host."
            },
            "duckRatio": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          },
          "required": ["mode", "trackPath"],
          "additionalProperties": false
        }
      },
      "additionalProperties": false,
      "default": {}
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["videoPath", "subtitlePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## compose.queue

Inspect the shared video composition queue.

- CLI：`smartsub compose queue`
- MCP：`smartsub_compose_queue`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## compose.encoders

Available hardware video encoders.

- CLI：`smartsub compose encoders`
- MCP：`smartsub_compose_encoders`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## compose.fonts

Installed fonts for subtitle composition.

- CLI：`smartsub compose fonts`
- MCP：`smartsub_compose_fonts`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## compose.presets

List subtitle style presets.

- CLI：`smartsub compose presets`
- MCP：`smartsub_compose_presets`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## compose.save-preset

Save a subtitle style preset.

- CLI：`smartsub compose save-preset`
- MCP：`smartsub_compose_save_preset`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "preset": {
      "type": "object",
      "additionalProperties": {},
      "description": "Advanced SmartSub configuration. See the linked operation reference for the corresponding application type."
    }
  },
  "required": ["preset"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## compose.delete-preset

Delete a subtitle style preset.

- CLI：`smartsub compose delete-preset`
- MCP：`smartsub_compose_delete_preset`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## providers.list

List saved providers without secret values. configured reports local configuration completeness (not network health); translation isAi providers support AI refinement, while ASR and TTS use separate provider kinds.

- CLI：`smartsub providers list`
- MCP：`smartsub_providers_list`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["translation", "asr", "tts"]
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## providers.types

Discover provider types, supported capabilities and configuration fields before creating an instance.

- CLI：`smartsub providers types`
- MCP：`smartsub_providers_types`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["translation", "asr", "tts"]
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## providers.save

Create or patch a provider by ID. Omitted credentials are preserved; secrets are write-only.

- CLI：`smartsub providers save`
- MCP：`smartsub_providers_save`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["translation", "asr", "tts"]
    },
    "provider": {
      "type": "object",
      "additionalProperties": {}
    }
  },
  "required": ["kind", "provider"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## providers.delete

Delete one configured provider by ID.

- CLI：`smartsub providers delete`
- MCP：`smartsub_providers_delete`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["translation", "asr", "tts"]
    },
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["kind", "id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## providers.test

Test a configured provider connection; may make a billable request.

- CLI：`smartsub providers test`
- MCP：`smartsub_providers_test`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["translation", "asr", "tts"]
    },
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["kind", "id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## providers.health

Cached service health; does not send network requests.

- CLI：`smartsub providers health`
- MCP：`smartsub_providers_health`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## settings.get

Read redacted application settings and task defaults.

- CLI：`smartsub settings get`
- MCP：`smartsub_settings_get`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## settings.update

Patch validated application settings; preserves omitted fields.

- CLI：`smartsub settings update`
- MCP：`smartsub_settings_update`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "settings": {
      "type": "object",
      "additionalProperties": {}
    }
  },
  "required": ["settings"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## models.list

List installed ASR, TTS and speaker models and runtime status.

- CLI：`smartsub models list`
- MCP：`smartsub_models_list`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## models.install

Download a catalog model; returns a job ID.

- CLI：`smartsub models install`
- MCP：`smartsub_models_install`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "engine": {
      "type": "string",
      "enum": [
        "builtin",
        "fasterWhisper",
        "funasr",
        "qwen",
        "fireRedAsr",
        "parakeet",
        "tts",
        "speakerDiarization"
      ]
    },
    "model": {
      "type": "string",
      "minLength": 1
    },
    "source": {
      "type": "string",
      "minLength": 1,
      "default": "huggingface"
    },
    "needsCoreML": {
      "type": "boolean",
      "default": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["engine"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## models.delete

Delete a model only while transcription and synthesis are idle.

- CLI：`smartsub models delete`
- MCP：`smartsub_models_delete`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "engine": {
      "type": "string",
      "enum": [
        "builtin",
        "fasterWhisper",
        "funasr",
        "qwen",
        "fireRedAsr",
        "parakeet",
        "tts",
        "speakerDiarization"
      ]
    },
    "model": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["engine"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## models.import

Import a local model file or directory with existing layout validation.

- CLI：`smartsub models import`
- MCP：`smartsub_models_import`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "engine": {
      "type": "string",
      "enum": [
        "builtin",
        "fasterWhisper",
        "funasr",
        "qwen",
        "fireRedAsr",
        "parakeet",
        "tts"
      ]
    },
    "modelId": {
      "type": "string",
      "minLength": 1
    },
    "sourcePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["engine", "sourcePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## engines.list

List ASR engine availability.

- CLI：`smartsub engines list`
- MCP：`smartsub_engines_list`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## engines.install

Install the faster-whisper runtime. Poll engines.progress until installation ends.

- CLI：`smartsub engines install`
- MCP：`smartsub_engines_install`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "source": {
      "type": "string",
      "minLength": 1,
      "default": "github"
    },
    "variant": {
      "type": "string",
      "enum": ["cpu", "cuda"]
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## engines.progress

Runtime installation progress.

- CLI：`smartsub engines progress`
- MCP：`smartsub_engines_progress`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## engines.cancel

Cancel runtime installation.

- CLI：`smartsub engines cancel`
- MCP：`smartsub_engines_cancel`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## engines.remove

Remove faster-whisper runtime when idle.

- CLI：`smartsub engines remove`
- MCP：`smartsub_engines_remove`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## engines.import

Import a faster-whisper runtime archive.

- CLI：`smartsub engines import`
- MCP：`smartsub_engines_import`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "sourcePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["sourcePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tts.voices

List voices for a configured cloud TTS provider or installed local models.

- CLI：`smartsub tts voices`
- MCP：`smartsub_tts_voices`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "minLength": 1
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## tts.synthesize

Synthesize text to an audio file. Select exactly one of model (installed local TTS, from models.list) or providerId (configured cloud TTS, from providers.list(kind="tts")). Select voice via tts.voices or voices.list and set language to the spoken language.

- CLI：`smartsub tts synthesize`
- MCP：`smartsub_tts_synthesize`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "minLength": 1
    },
    "providerId": {
      "type": "string",
      "minLength": 1
    },
    "model": {
      "type": "string",
      "minLength": 1
    },
    "voice": {
      "type": "string",
      "minLength": 1
    },
    "language": {
      "type": "string",
      "minLength": 1,
      "default": "en"
    },
    "outputPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["text", "voice"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.get

Read a persisted dubbing session.

- CLI：`smartsub dubbing get`
- MCP：`smartsub_dubbing_get`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["sessionId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.create

Create a dubbing session from subtitles and optional media.

- CLI：`smartsub dubbing create`
- MCP：`smartsub_dubbing_create`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "subtitlePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "videoPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "proofreadDataFile": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["subtitlePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.run

Synthesize all or stale subtitle cues. config uses DubbingConfig.

- CLI：`smartsub dubbing run`
- MCP：`smartsub_dubbing_run`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "config": {
      "type": "object",
      "properties": {
        "engine": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "local"
                },
                "modelId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "modelId"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "cloud"
                },
                "providerId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "providerId"],
              "additionalProperties": false
            }
          ]
        },
        "voice": {
          "type": "string",
          "minLength": 1
        },
        "language": {
          "type": "string",
          "minLength": 1
        },
        "globalSpeed": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 2,
          "default": 1
        },
        "cloneQuality": {
          "type": "string",
          "enum": ["standard", "high"]
        },
        "localConcurrency": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "overflow": {
          "type": "string",
          "enum": ["truncate", "shift"]
        },
        "overlapMode": {
          "type": "string",
          "enum": ["shift", "mix"]
        },
        "background": {
          "type": "string",
          "enum": ["mute", "duck"],
          "default": "mute"
        },
        "output": {
          "type": "string",
          "enum": ["audioOnly", "replaceTrack", "mixTrack", "addTrack"],
          "default": "audioOnly"
        },
        "audioFormat": {
          "type": "string",
          "enum": ["wav", "mp3"]
        },
        "exportShiftedSubtitle": {
          "type": "boolean"
        }
      },
      "required": ["engine", "voice"],
      "additionalProperties": false
    },
    "force": {
      "type": "boolean"
    },
    "staleOnly": {
      "type": "boolean"
    },
    "speakerId": {
      "type": "integer"
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["sessionId", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.export

Export the synthesized track or dubbed video using DubbingConfig.

- CLI：`smartsub dubbing export`
- MCP：`smartsub_dubbing_export`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "config": {
      "type": "object",
      "properties": {
        "engine": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "local"
                },
                "modelId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "modelId"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "cloud"
                },
                "providerId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "providerId"],
              "additionalProperties": false
            }
          ]
        },
        "voice": {
          "type": "string",
          "minLength": 1
        },
        "language": {
          "type": "string",
          "minLength": 1
        },
        "globalSpeed": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 2,
          "default": 1
        },
        "cloneQuality": {
          "type": "string",
          "enum": ["standard", "high"]
        },
        "localConcurrency": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "overflow": {
          "type": "string",
          "enum": ["truncate", "shift"]
        },
        "overlapMode": {
          "type": "string",
          "enum": ["shift", "mix"]
        },
        "background": {
          "type": "string",
          "enum": ["mute", "duck"],
          "default": "mute"
        },
        "output": {
          "type": "string",
          "enum": ["audioOnly", "replaceTrack", "mixTrack", "addTrack"],
          "default": "audioOnly"
        },
        "audioFormat": {
          "type": "string",
          "enum": ["wav", "mp3"]
        },
        "exportShiftedSubtitle": {
          "type": "boolean"
        }
      },
      "required": ["engine", "voice"],
      "additionalProperties": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["sessionId", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.resynthesize

Resynthesize one cue with optional revised text and voice.

- CLI：`smartsub dubbing resynthesize`
- MCP：`smartsub_dubbing_resynthesize`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "index": {
      "type": "integer",
      "minimum": 0
    },
    "text": {
      "type": "string"
    },
    "voiceId": {
      "type": "string",
      "minLength": 1
    },
    "config": {
      "type": "object",
      "properties": {
        "engine": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "local"
                },
                "modelId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "modelId"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "cloud"
                },
                "providerId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "providerId"],
              "additionalProperties": false
            }
          ]
        },
        "voice": {
          "type": "string",
          "minLength": 1
        },
        "language": {
          "type": "string",
          "minLength": 1
        },
        "globalSpeed": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 2,
          "default": 1
        },
        "cloneQuality": {
          "type": "string",
          "enum": ["standard", "high"]
        },
        "localConcurrency": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "overflow": {
          "type": "string",
          "enum": ["truncate", "shift"]
        },
        "overlapMode": {
          "type": "string",
          "enum": ["shift", "mix"]
        },
        "background": {
          "type": "string",
          "enum": ["mute", "duck"],
          "default": "mute"
        },
        "output": {
          "type": "string",
          "enum": ["audioOnly", "replaceTrack", "mixTrack", "addTrack"],
          "default": "audioOnly"
        },
        "audioFormat": {
          "type": "string",
          "enum": ["wav", "mp3"]
        },
        "exportShiftedSubtitle": {
          "type": "boolean"
        }
      },
      "required": ["engine", "voice"],
      "additionalProperties": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["sessionId", "index", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.edit

Update cue texts with expected values using the existing session editing rules.

- CLI：`smartsub dubbing edit`
- MCP：`smartsub_dubbing_edit`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "edits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": {
            "type": "integer",
            "minimum": 0
          },
          "startMs": {
            "type": "number",
            "minimum": 0
          },
          "endMs": {
            "type": "number",
            "minimum": 0
          },
          "baseText": {
            "type": "string"
          },
          "text": {
            "type": "string"
          }
        },
        "required": ["index", "startMs", "endMs", "baseText", "text"],
        "additionalProperties": false
      }
    }
  },
  "required": ["sessionId", "edits"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.speaker-voice

Set the voice for a speaker.

- CLI：`smartsub dubbing speaker-voice`
- MCP：`smartsub_dubbing_speaker_voice`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "speakerId": {
      "type": "integer"
    },
    "voiceId": {
      "type": "string",
      "minLength": 1
    },
    "globalVoiceId": {
      "type": "string",
      "minLength": 1
    },
    "config": {
      "type": "object",
      "properties": {
        "engine": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "local"
                },
                "modelId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "modelId"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "cloud"
                },
                "providerId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "providerId"],
              "additionalProperties": false
            }
          ]
        },
        "voice": {
          "type": "string",
          "minLength": 1
        },
        "language": {
          "type": "string",
          "minLength": 1
        },
        "globalSpeed": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 2,
          "default": 1
        },
        "cloneQuality": {
          "type": "string",
          "enum": ["standard", "high"]
        },
        "localConcurrency": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "overflow": {
          "type": "string",
          "enum": ["truncate", "shift"]
        },
        "overlapMode": {
          "type": "string",
          "enum": ["shift", "mix"]
        },
        "background": {
          "type": "string",
          "enum": ["mute", "duck"],
          "default": "mute"
        },
        "output": {
          "type": "string",
          "enum": ["audioOnly", "replaceTrack", "mixTrack", "addTrack"],
          "default": "audioOnly"
        },
        "audioFormat": {
          "type": "string",
          "enum": ["wav", "mp3"]
        },
        "exportShiftedSubtitle": {
          "type": "boolean"
        }
      },
      "required": ["engine", "voice"],
      "additionalProperties": false
    }
  },
  "required": ["sessionId", "speakerId", "voiceId", "globalVoiceId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.speaker-settings

Set per-speaker synthesis settings.

- CLI：`smartsub dubbing speaker-settings`
- MCP：`smartsub_dubbing_speaker_settings`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "speakerId": {
      "type": "integer"
    },
    "settings": {
      "type": "object",
      "properties": {
        "speed": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 2
        },
        "pitch": {
          "type": "number",
          "minimum": -12,
          "maximum": 12
        }
      },
      "required": ["speed", "pitch"],
      "additionalProperties": false
    },
    "config": {
      "type": "object",
      "properties": {
        "engine": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "local"
                },
                "modelId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "modelId"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "cloud"
                },
                "providerId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "providerId"],
              "additionalProperties": false
            }
          ]
        },
        "voice": {
          "type": "string",
          "minLength": 1
        },
        "language": {
          "type": "string",
          "minLength": 1
        },
        "globalSpeed": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 2,
          "default": 1
        },
        "cloneQuality": {
          "type": "string",
          "enum": ["standard", "high"]
        },
        "localConcurrency": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "overflow": {
          "type": "string",
          "enum": ["truncate", "shift"]
        },
        "overlapMode": {
          "type": "string",
          "enum": ["shift", "mix"]
        },
        "background": {
          "type": "string",
          "enum": ["mute", "duck"],
          "default": "mute"
        },
        "output": {
          "type": "string",
          "enum": ["audioOnly", "replaceTrack", "mixTrack", "addTrack"],
          "default": "audioOnly"
        },
        "audioFormat": {
          "type": "string",
          "enum": ["wav", "mp3"]
        },
        "exportShiftedSubtitle": {
          "type": "boolean"
        }
      },
      "required": ["engine", "voice"],
      "additionalProperties": false
    }
  },
  "required": ["sessionId", "speakerId", "settings"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.cue-voice

Set an individual cue voice.

- CLI：`smartsub dubbing cue-voice`
- MCP：`smartsub_dubbing_cue_voice`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "index": {
      "type": "integer",
      "minimum": 0
    },
    "voiceId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["sessionId", "index", "voiceId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.media

Set the video associated with a dubbing session.

- CLI：`smartsub dubbing media`
- MCP：`smartsub_dubbing_media`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "videoPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["sessionId", "videoPath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## dubbing.borrow-silence

Extend a cue into available following silence.

- CLI：`smartsub dubbing borrow-silence`
- MCP：`smartsub_dubbing_borrow_silence`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "minLength": 1
    },
    "index": {
      "type": "integer",
      "minimum": 0
    },
    "config": {
      "type": "object",
      "properties": {
        "engine": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "local"
                },
                "modelId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "modelId"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "cloud"
                },
                "providerId": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["kind", "providerId"],
              "additionalProperties": false
            }
          ]
        },
        "voice": {
          "type": "string",
          "minLength": 1
        },
        "language": {
          "type": "string",
          "minLength": 1
        },
        "globalSpeed": {
          "type": "number",
          "minimum": 0.5,
          "maximum": 2,
          "default": 1
        },
        "cloneQuality": {
          "type": "string",
          "enum": ["standard", "high"]
        },
        "localConcurrency": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "overflow": {
          "type": "string",
          "enum": ["truncate", "shift"]
        },
        "overlapMode": {
          "type": "string",
          "enum": ["shift", "mix"]
        },
        "background": {
          "type": "string",
          "enum": ["mute", "duck"],
          "default": "mute"
        },
        "output": {
          "type": "string",
          "enum": ["audioOnly", "replaceTrack", "mixTrack", "addTrack"],
          "default": "audioOnly"
        },
        "audioFormat": {
          "type": "string",
          "enum": ["wav", "mp3"]
        },
        "exportShiftedSubtitle": {
          "type": "boolean"
        }
      },
      "required": ["engine", "voice"],
      "additionalProperties": false
    }
  },
  "required": ["sessionId", "index", "config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.list

List cloned voices.

- CLI：`smartsub voices list`
- MCP：`smartsub_voices_list`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.analyze

Analyze reference audio before cloning.

- CLI：`smartsub voices analyze`
- MCP：`smartsub_voices_analyze`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "sourcePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "engine": {
      "type": "string",
      "enum": ["zipvoice", "volcengine", "elevenlabs"]
    }
  },
  "required": ["sourcePath", "engine"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.inspect

Inspect a candidate reference range.

- CLI：`smartsub voices inspect`
- MCP：`smartsub_voices_inspect`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "analysisId": {
      "type": "string",
      "minLength": 1
    },
    "startMs": {
      "type": "number",
      "minimum": 0
    },
    "endMs": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "engine": {
      "type": "string",
      "enum": ["zipvoice", "volcengine", "elevenlabs"]
    }
  },
  "required": ["analysisId", "startMs", "endMs", "engine"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.denoise

Create denoised reference audio.

- CLI：`smartsub voices denoise`
- MCP：`smartsub_voices_denoise`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "analysisId": {
      "type": "string",
      "minLength": 1
    },
    "startMs": {
      "type": "number",
      "minimum": 0
    },
    "endMs": {
      "type": "number",
      "exclusiveMinimum": 0
    }
  },
  "required": ["analysisId", "startMs", "endMs"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.transcribe

Transcribe a reference audio range.

- CLI：`smartsub voices transcribe`
- MCP：`smartsub_voices_transcribe`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "analysisId": {
      "type": "string",
      "minLength": 1
    },
    "startMs": {
      "type": "number",
      "minimum": 0
    },
    "endMs": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "language": {
      "type": "string",
      "enum": ["zh", "en"]
    }
  },
  "required": ["analysisId", "startMs", "endMs", "language"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.create

Create a cloned voice from a previously analyzed range.

- CLI：`smartsub voices create`
- MCP：`smartsub_voices_create`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "analysisId": {
      "type": "string",
      "minLength": 1
    },
    "startMs": {
      "type": "number",
      "minimum": 0
    },
    "endMs": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "engine": {
      "type": "string",
      "enum": ["zipvoice", "volcengine", "elevenlabs"]
    },
    "language": {
      "type": "string",
      "enum": ["zh", "en"]
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "refText": {
      "type": "string",
      "minLength": 1
    },
    "localDenoise": {
      "type": "boolean"
    },
    "volc": {
      "type": "object",
      "additionalProperties": {},
      "description": "Advanced SmartSub configuration. See the linked operation reference for the corresponding application type."
    },
    "eleven": {
      "type": "object",
      "additionalProperties": {},
      "description": "Advanced SmartSub configuration. See the linked operation reference for the corresponding application type."
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": [
    "analysisId",
    "startMs",
    "endMs",
    "engine",
    "language",
    "name",
    "refText"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.rename

Rename a cloned voice.

- CLI：`smartsub voices rename`
- MCP：`smartsub_voices_rename`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "name": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id", "name"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.delete

Remove a cloned voice. removeCloud explicitly opts into deleting the remote voice.

- CLI：`smartsub voices delete`
- MCP：`smartsub_voices_delete`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "removeCloud": {
      "type": "boolean",
      "default": false
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.cloud

List voices from a cloud provider.

- CLI：`smartsub voices cloud`
- MCP：`smartsub_voices_cloud`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["providerId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.link

Link an existing cloud voice.

- CLI：`smartsub voices link`
- MCP：`smartsub_voices_link`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "engine": {
      "type": "string",
      "enum": ["volcengine", "elevenlabs"]
    },
    "providerId": {
      "type": "string",
      "minLength": 1
    },
    "speakerId": {
      "type": "string",
      "minLength": 1
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "language": {
      "type": "string",
      "enum": ["zh", "en"]
    }
  },
  "required": ["engine", "providerId", "speakerId", "language"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.status

Refresh cloud clone training status.

- CLI：`smartsub voices status`
- MCP：`smartsub_voices_status`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.retrain

Retrain a cloud voice.

- CLI：`smartsub voices retrain`
- MCP：`smartsub_voices_retrain`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "denoise": {
      "type": "boolean"
    },
    "mss": {
      "type": "boolean"
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.sample

Regenerate a cloned voice sample.

- CLI：`smartsub voices sample`
- MCP：`smartsub_voices_sample`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.export

Export a voice package to a new explicit path.

- CLI：`smartsub voices export`
- MCP：`smartsub_voices_export`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "outputPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["id", "outputPath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## voices.import

Import a voice package from a local file.

- CLI：`smartsub voices import`
- MCP：`smartsub_voices_import`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "sourcePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["sourcePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.engines

Download engine installation status without a network update check.

- CLI：`smartsub downloads engines`
- MCP：`smartsub_downloads_engines`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {
    "source": {
      "type": "string",
      "minLength": 1,
      "default": "github"
    },
    "fetchRemote": {
      "type": "boolean",
      "default": false
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.install

Install or update yt-dlp or lux.

- CLI：`smartsub downloads install`
- MCP：`smartsub_downloads_install`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "engine": {
      "type": "string",
      "enum": ["yt-dlp", "lux"]
    },
    "source": {
      "type": "string",
      "minLength": 1,
      "default": "github"
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["engine"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.check

Inspect video links and available formats.

- CLI：`smartsub downloads check`
- MCP：`smartsub_downloads_check`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "urls": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "minItems": 1
    },
    "engine": {
      "type": "string",
      "enum": ["auto", "yt-dlp", "lux"],
      "default": "auto"
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["urls"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.start

Download links; config uses StartDownloadPayload. Returns a job ID.

- CLI：`smartsub downloads start`
- MCP：`smartsub_downloads_start`
- 属性：修改/执行；异步任务

```json
{
  "type": "object",
  "properties": {
    "config": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "savePath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute local file or directory path on the SmartSub host."
        },
        "quality": {
          "type": "string",
          "enum": ["best", "1080p", "720p"],
          "default": "best"
        },
        "engine": {
          "type": "string",
          "enum": ["auto", "yt-dlp", "lux"],
          "default": "auto"
        },
        "writeSubs": {
          "type": "boolean",
          "default": true
        },
        "concurrency": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "format": "uri"
              },
              "expandPlaylist": {
                "type": "boolean"
              },
              "meta": {
                "type": "object",
                "additionalProperties": {}
              }
            },
            "required": ["url"],
            "additionalProperties": false
          },
          "minItems": 1
        },
        "autoChain": {
          "type": "object",
          "properties": {
            "recipeId": {
              "type": "string",
              "minLength": 1
            },
            "cloudUploadConsent": {
              "type": "boolean"
            },
            "configKey": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": ["recipeId", "configKey"],
          "additionalProperties": false
        }
      },
      "required": ["name", "savePath", "entries"],
      "additionalProperties": false
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Reuse only to retry the same submission without running it twice."
    }
  },
  "required": ["config"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.resume

Resume a download batch.

- CLI：`smartsub downloads resume`
- MCP：`smartsub_downloads_resume`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "workItemId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["workItemId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.retry

Retry one download entry.

- CLI：`smartsub downloads retry`
- MCP：`smartsub_downloads_retry`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "workItemId": {
      "type": "string",
      "minLength": 1
    },
    "entryId": {
      "type": "string",
      "minLength": 1
    },
    "updateFirst": {
      "type": "boolean",
      "default": false
    }
  },
  "required": ["workItemId", "entryId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.cookies

List Cookie profile metadata; cookie contents are never returned.

- CLI：`smartsub downloads cookies`
- MCP：`smartsub_downloads_cookies`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.import-cookies

Import a Netscape cookie file for a configured site.

- CLI：`smartsub downloads import-cookies`
- MCP：`smartsub_downloads_import_cookies`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "sourcePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    },
    "customDef": {
      "type": "object",
      "additionalProperties": {},
      "description": "Advanced SmartSub configuration. See the linked operation reference for the corresponding application type."
    }
  },
  "required": ["id", "sourcePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## downloads.delete-cookies

Delete a cookie profile.

- CLI：`smartsub downloads delete-cookies`
- MCP：`smartsub_downloads_delete_cookies`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.list

List glossary collections and entries.

- CLI：`smartsub glossaries list`
- MCP：`smartsub_glossaries_list`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.create

Create a glossary.

- CLI：`smartsub glossaries create`
- MCP：`smartsub_glossaries_create`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string"
    }
  },
  "required": ["name"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.update

Patch a glossary.

- CLI：`smartsub glossaries update`
- MCP：`smartsub_glossaries_update`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "patch": {
      "type": "object",
      "additionalProperties": {}
    }
  },
  "required": ["id", "patch"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.delete

Delete a glossary.

- CLI：`smartsub glossaries delete`
- MCP：`smartsub_glossaries_delete`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.save-entry

Create or update a glossary entry.

- CLI：`smartsub glossaries save-entry`
- MCP：`smartsub_glossaries_save_entry`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "glossaryId": {
      "type": "string",
      "minLength": 1
    },
    "entry": {
      "type": "object",
      "additionalProperties": {}
    }
  },
  "required": ["glossaryId", "entry"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.delete-entry

Remove one glossary entry.

- CLI：`smartsub glossaries delete-entry`
- MCP：`smartsub_glossaries_delete_entry`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "glossaryId": {
      "type": "string",
      "minLength": 1
    },
    "entryId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["glossaryId", "entryId"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.import

Import CSV/TXT entries.

- CLI：`smartsub glossaries import`
- MCP：`smartsub_glossaries_import`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "glossaryId": {
      "type": "string",
      "minLength": 1
    },
    "sourcePath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["glossaryId", "sourcePath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## glossaries.export

Export a glossary to a new file.

- CLI：`smartsub glossaries export`
- MCP：`smartsub_glossaries_export`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "glossaryId": {
      "type": "string",
      "minLength": 1
    },
    "format": {
      "type": "string",
      "enum": ["csv", "txt"]
    },
    "outputPath": {
      "type": "string",
      "minLength": 1,
      "description": "Absolute local file or directory path on the SmartSub host."
    }
  },
  "required": ["glossaryId", "format", "outputPath"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## recipes.list

List saved workflow recipes.

- CLI：`smartsub recipes list`
- MCP：`smartsub_recipes_list`
- 属性：读取；直接返回

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## recipes.save

Save a workflow recipe: name,goals,accepts,config.

- CLI：`smartsub recipes save`
- MCP：`smartsub_recipes_save`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "recipe": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string",
          "minLength": 1
        },
        "goals": {
          "type": "object",
          "properties": {
            "translate": {
              "type": "boolean"
            },
            "dub": {
              "type": "boolean"
            },
            "video": {
              "type": "boolean"
            }
          },
          "required": ["translate", "dub", "video"],
          "additionalProperties": false
        },
        "accepts": {
          "type": "string",
          "enum": ["media", "subtitle"]
        },
        "config": {
          "type": "object",
          "properties": {
            "dub": {
              "type": "object",
              "properties": {
                "engine": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "local"
                        },
                        "modelId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": ["kind", "modelId"],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "cloud"
                        },
                        "providerId": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": ["kind", "providerId"],
                      "additionalProperties": false
                    }
                  ]
                },
                "voice": {
                  "type": "string",
                  "minLength": 1
                },
                "language": {
                  "type": "string",
                  "minLength": 1
                },
                "globalSpeed": {
                  "type": "number",
                  "minimum": 0.5,
                  "maximum": 2,
                  "default": 1
                },
                "cloneQuality": {
                  "type": "string",
                  "enum": ["standard", "high"]
                },
                "localConcurrency": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 3
                },
                "overflow": {
                  "type": "string",
                  "enum": ["truncate", "shift"]
                },
                "overlapMode": {
                  "type": "string",
                  "enum": ["shift", "mix"]
                }
              },
              "required": ["engine", "voice"],
              "additionalProperties": false,
              "description": "Opt-in dubbing. Use models.list for local TTS or providers.list(kind=\"tts\") for cloud; choose a compatible voice with tts.voices or voices.list. Chat and ASR services cannot provide TTS."
            },
            "compose": {
              "type": "object",
              "properties": {
                "subtitle": {
                  "type": "string",
                  "enum": ["hard", "soft", "none"]
                },
                "style": {
                  "type": "object",
                  "properties": {
                    "fontName": {
                      "type": "string",
                      "minLength": 1
                    },
                    "fontSize": {
                      "type": "number",
                      "minimum": 10,
                      "maximum": 72
                    },
                    "primaryColor": {
                      "type": "string",
                      "minLength": 1
                    },
                    "outlineColor": {
                      "type": "string",
                      "minLength": 1
                    },
                    "backColor": {
                      "type": "string",
                      "minLength": 1
                    },
                    "backOpacity": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 100
                    },
                    "bold": {
                      "type": "boolean"
                    },
                    "italic": {
                      "type": "boolean"
                    },
                    "underline": {
                      "type": "boolean"
                    },
                    "borderStyle": {
                      "type": "number",
                      "enum": [1, 3]
                    },
                    "outline": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 10
                    },
                    "shadow": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 10
                    },
                    "alignment": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9
                    },
                    "marginL": {
                      "type": "number",
                      "minimum": 0
                    },
                    "marginR": {
                      "type": "number",
                      "minimum": 0
                    },
                    "marginV": {
                      "type": "number",
                      "minimum": 0
                    },
                    "positionY": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 100
                    },
                    "secondLineColor": {
                      "type": "string",
                      "minLength": 1
                    },
                    "highlightTerms": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "highlightColor": {
                      "type": "string",
                      "minLength": 1
                    },
                    "glow": {
                      "type": "number",
                      "minimum": 0
                    },
                    "glowColor": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "additionalProperties": true
                },
                "styleId": {
                  "type": "string",
                  "minLength": 1
                },
                "styleName": {
                  "type": "string",
                  "minLength": 1
                },
                "videoQuality": {
                  "type": "string",
                  "enum": ["original", "high", "standard"]
                },
                "encoderMode": {
                  "type": "string",
                  "enum": ["cpu", "hardware"]
                }
              },
              "required": ["subtitle"],
              "additionalProperties": false
            },
            "gates": {
              "type": "object",
              "properties": {
                "subtitle": {
                  "type": "string",
                  "enum": ["auto", "manual"],
                  "default": "auto"
                },
                "dubbing": {
                  "type": "string",
                  "enum": ["auto", "manual"],
                  "default": "auto"
                }
              },
              "additionalProperties": false
            },
            "asrProviderId": {
              "type": "string",
              "minLength": 1,
              "description": "Cloud ASR provider ID from providers.list(kind=\"asr\"). Requires engine=\"cloud\" and a model in that provider's models list. Independent from translation/refinement/chat."
            },
            "translateProvider": {
              "type": "string",
              "minLength": 1,
              "description": "Translation provider ID from providers.list(kind=\"translation\"). Required for translate and translating pipelines; \"-1\" is not a valid translation selection."
            },
            "useEmbeddedSubtitles": {
              "type": "boolean"
            },
            "translateContent": {
              "type": "string",
              "enum": [
                "onlyTranslate",
                "sourceAndTranslate",
                "translateAndSource"
              ]
            },
            "subtitleOutputFormats": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": ["srt", "vtt", "ass", "lrc", "txt"]
              },
              "minItems": 1
            },
            "subtitleLayout": {
              "type": "string",
              "enum": ["original", "two-line"]
            },
            "subtitleLineWidth": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxSubtitleChars": {
              "type": "number",
              "minimum": -1
            },
            "subtitleMaxDuration": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "subtitleMaxGap": {
              "type": "number",
              "minimum": 0
            },
            "preserveSpeechPauses": {
              "type": "boolean",
              "description": "Preserve speech gaps during subtitle segmentation. Does not require an AI provider by itself."
            },
            "aiSegmentation": {
              "type": "boolean",
              "description": "Opt-in AI semantic segmentation of ASR output. Defaults to false for automation. Requires a configured AI refineProvider; do not enable just to generate original SRT."
            },
            "aiCorrection": {
              "type": "boolean",
              "description": "Opt-in AI correction of ASR text. Defaults to false for automation. Requires a configured AI refineProvider."
            },
            "refineProvider": {
              "type": "string",
              "minLength": 1,
              "description": "AI provider ID from providers.list(kind=\"translation\") with isAi=true and configured=true. Required for AI segmentation/correction. Omitted or \"follow-translation\" uses the task translation provider. The in-app assistant can use its current AI service when omitted and no task service resolves. Explicit selections are never replaced."
            },
            "subtitleTranslationStyle": {
              "type": "string",
              "enum": ["neutral", "conversational"],
              "description": "Defaults to neutral. Conversational style requires a configured AI translation provider, including translate-only tasks."
            },
            "speakerDiarization": {
              "type": "boolean",
              "description": "Opt-in speaker identification for media. Requires installed speaker models and Sherpa runtime; inspect models.list before enabling."
            },
            "speakerDiarizationCount": {
              "type": "integer",
              "minimum": 0,
              "maximum": 8
            },
            "speakerDiarizationEmbedInSubtitle": {
              "type": "boolean"
            },
            "manuscriptPath": {
              "type": "string",
              "minLength": 1,
              "description": "Absolute local file or directory path on the SmartSub host."
            }
          },
          "additionalProperties": true,
          "description": "Task overrides. Optional AI refinement, speaker identification, dubbing, composition and manuscript inputs are disabled unless supplied here. Engine/model/provider preferences are inherited from settings.get.defaults. Further IFormData fields are accepted for compatibility; see types/types.ts."
        }
      },
      "required": ["name", "goals", "accepts"],
      "additionalProperties": false
    }
  },
  "required": ["recipe"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## recipes.delete

Delete a saved recipe.

- CLI：`smartsub recipes delete`
- MCP：`smartsub_recipes_delete`
- 属性：修改/执行；直接返回

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```
