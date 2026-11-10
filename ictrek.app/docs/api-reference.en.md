# V-Sub API

## Interfaces and addresses

VOS: `http://v-sub-backend:7090`, host `http://HOST:22703`, same-origin `/app/com.ictrek.v-sub`. The sidebar API guide distinguishes VOS HTTP, Scheduler integration and the standalone desktop MCP/CLI.

The desktop smartsub CLI and stdio MCP connect to a dynamic loopback port on the desktop user's machine. Desktop `/call` is not published through VOS 7090/22703. Endpoint files and worker tokens are private capabilities, not public API Keys. External applications should discover speech models through V-Scheduler rather than connect to another user's worker.

## VOS identity, permissions and credentials

Verified immutable VOS subjects select private storage and OS UIDs. Each user has a separate runtime. There is no personal API Key create/update/list API. Provider apiKey settings are upstream secrets, not V-Sub access Keys. Worker and Scheduler execution tokens remain internal.

- `GET /health`: public200 `{ok,version,workers}`; gateway health does not prove weights, calibration or inference readiness.
- `GET /api/auth/pkce`:200 `{verifier,state,nonce,challenge}`; S256 challenge. Complete VOS OIDC before exchanging access_token for the application cookie.
- `POST /api/auth/vos-oidc`: JSON `{ "access_token": "VOS_ACCESS_TOKEN" }`;200 `{authenticated:true,user:{username,namespace}}` and a one-hour HttpOnly/SameSite Strict v_sub_session cookie. Writes require valid request origin. Static-page access is not authentication.
- `/api/auth/session`: normally GET;200/401 with enabled, authenticated, clientId, scope and optional user. Subsequent user HTTP/IPC calls use the cookie.
- `GET /api/v1/discovery`: independently accepts VOS Bearer and discovers that user's local models;401/503 on failure. Discovery alone does not imply calibration.

```bash
BASE=http://HOST:22703
curl -c "$COOKIE_FILE" "$BASE/api/auth/vos-oidc" -H 'Content-Type: application/json' --data "{\"access_token\":\"$VOS_TOKEN\"}"
curl -b "$COOKIE_FILE" "$BASE/api/auth/session"
curl -b "$COOKIE_FILE" "$BASE/api/router"
curl -b "$COOKIE_FILE" "$BASE/api/ipc" -H 'Content-Type: application/json' --data '{"channel":"vos:runtime-status","args":[],"clientId":"example"}'
```

COOKIE_FILE is a private cookie-file path supplied by the caller. Keep real credentials out of logs.

## VOS data and event APIs

- `POST /api/upload?name=ENCODED_FILENAME`: raw bytes, not JSON/multipart;200 `{path}` under the current user's uploads. Default limit4GiB is configurable at installation. Oversize uploads can close the request rather than always return413; incomplete targets are removed.
- `GET/HEAD /media?path=ABSOLUTE_PATH[&download]`: real files within that user's root, with realpath/symlink confinement. Native media Content-Type, optional attachment header and single-range206/416.
- `POST /api/ipc`: JSON `{channel:string,args:array,mode?:"invoke"|"send",clientId?:string}`, default invoke.200 `{result,downloads:[absolute-path]}`; missing results become null. Special no-op channels can return only result. Arguments and outputs follow registered desktop handlers; arbitrary unregistered channels are unsupported. Failures commonly return400 `{error:string}`, or the Scheduler's status.
- `GET /api/router`: refreshes gateway/local-model status. IPC channels vos:router-status and vos:runtime-status query those states; connectivity alone does not establish inference calibration.
- `GET /api/events?clientId=ID`: SSE `data: {channel,args}` with15-second comment heartbeats. Uint8Array is encoded as `{__bytes:[0..255]}`. A browser environment disconnected for more than15seconds is destroyed. Refetch task state on reconnect; no event replay guarantee.
- `POST /api/dialog`: JSON `{id,paths:[absolute-path]}`;200 `{ok:true}`. Only unexpired selection requests and paths inside the user root are accepted. Dialog timeout120seconds. `POST /api/close` with `{clientId}` closes that browser environment, not stored subtitles/projects or every task.

IPC JSON limit8MiB; ordinary errors400, unauthenticated401, invalid origin403, unknown endpoint404, worker proxy failure502 and unavailable model/binding503. Parse binary, SSE and JSON independently.

## Model registration, budgets and stopping

GET/POST `/api/v1/scheduler/binding` and GET `/api/v1/scheduler/discovery` require the **V-Scheduler VOS application identity**, not a normal administrator-user token. Scheduler discovery, registration, calibration and binding are automatic; users do not deploy agents manually.

Binding fields: protocol_version=1, positive integer binding_revision, app_id=`com.ictrek.v-sub`, trusted Scheduler url, token, models (model→executor_id), namespaces (64hex), model_generations (32hex worker generation), model_limits and model_execution_settings. Each model must match an approved executor for this app, task_type=model.infer, contract_version=1 and the exact upstream URL. Invalid/missing calibration gives422. Identical content/revision is retryable; older revisions or changed content at the same revision give409. Active work prevents binding replacement. Success returns configured, protocol_version, binding_revision and approved_model_count, never the binding token.

Private `/internal/scheduler/:namespace/{plan,acquire,verify,release}` is loopback-worker-only. `/inference/:namespace/v1/*` requires internal worker credentials and admission evidence, not ordinary anonymous user access. Resource release follows actual stop evidence; an interrupted connection does not prove model unload.

VOS requests can carry task intent: x-vscheduler-priority (background/interactive/high), x-vscheduler-preemptible, x-vscheduler-allow-preemption, x-vscheduler-force-admission (string true/false), and x-vscheduler-queue-wait-seconds (integer0–300, default30). The app validates and forwards intent. Scheduler owns authorization, budgets and preemption; a force header does not grant administrator rights.

## Desktop MCP / CLI and task results

Copy platform-specific CLI/MCP settings from a standalone desktop installation. Stdio MCP uses the bundled runtime and can start the desktop background process on first use. The user-only endpoint.json contains a dynamic port and process token; do not share it.

Local HTTP GET `/health` returns apiVersion/version/pid. POST `/call` accepts `{operation,args}`;200 `{ok:true,result}` or400 `{ok:false,error:{code,message}}`. It requires127.0.0.1 Host, no Origin and the correct Bearer; otherwise401. Body limit8MiB. MCP tool results use structuredContent.result; inspect isError. This is not the public VOS HTTP interface.

Long operations return a persisted job ID. Job fields: id, operation, status, createdAt/updatedAt (epoch milliseconds), optional requestId/fingerprint/projectId/progress/result/error `{code,message,details}`, artifacts `[{kind,path}]` and actions. Statuses: queued/running/paused/review/cancelling/completed/failed/cancelled/interrupted. Review is not completed; manual workflows need release. tasks.get/tasks.wait inspect jobs; wait is capped at25seconds and a timeout does not cancel. tasks.cancel targets only that job/children; pause stops additional dispatch. Disconnecting MCP does not cancel persisted jobs. Reuse requestId only to retry the identical submission; changed inputs need a new ID.

Discover provider fields with providers.types. providers.save `{kind,provider}` creates/patches by ID, preserves omitted secrets and redacts reads. providers.test may incur upstream charges. These are not V-Scheduler access Key APIs. models.install/delete manages weight files, not automatic unload or cancellation of all jobs. The111 native schemas below share the application's operation catalogue.

## system.info

Application version, platform, profile, engine runtime paths (e.g. faster-whisper python runtime and binaries), storage topology (userData, storageRoot, temp, logs, models), installed models, hardware environment, providers, and architecture notes.

- CLI: `smartsub system info`
- MCP: `smartsub_system_info`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub system capabilities`
- MCP: `smartsub_system_capabilities`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub system logs`
- MCP: `smartsub_system_logs`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub system languages`
- MCP: `smartsub_system_languages`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub system sample`
- MCP: `smartsub_system_sample`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub tasks list`
- MCP: `smartsub_tasks_list`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub tasks get`
- MCP: `smartsub_tasks_get`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub tasks wait`
- MCP: `smartsub_tasks_wait`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub tasks cancel`
- MCP: `smartsub_tasks_cancel`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub tasks pause`
- MCP: `smartsub_tasks_pause`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub tasks resume`
- MCP: `smartsub_tasks_resume`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub tasks retry`
- MCP: `smartsub_tasks_retry`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub tasks delete`
- MCP: `smartsub_tasks_delete`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub transcribe`
- MCP: `smartsub_transcribe`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub translate`
- MCP: `smartsub_translate`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub pipeline run`
- MCP: `smartsub_pipeline_run`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub pipeline release`
- MCP: `smartsub_pipeline_release`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub subtitles read`
- MCP: `smartsub_subtitles_read`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub subtitles write`
- MCP: `smartsub_subtitles_write`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub subtitles validate`
- MCP: `smartsub_subtitles_validate`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub subtitles detect-language`
- MCP: `smartsub_subtitles_detect_language`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub subtitles scan`
- MCP: `smartsub_subtitles_scan`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub subtitles encoding`
- MCP: `smartsub_subtitles_encoding`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub subtitles convert`
- MCP: `smartsub_subtitles_convert`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub subtitles sync`
- MCP: `smartsub_subtitles_sync`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub subtitles merge`
- MCP: `smartsub_subtitles_merge`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub subtitles split`
- MCP: `smartsub_subtitles_split`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub subtitles optimize`
- MCP: `smartsub_subtitles_optimize`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub subtitles retranslate`
- MCP: `smartsub_subtitles_retranslate`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub proofread read`
- MCP: `smartsub_proofread_read`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub proofread save`
- MCP: `smartsub_proofread_save`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub media probe`
- MCP: `smartsub_media_probe`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub media subtitles`
- MCP: `smartsub_media_subtitles`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub media trim`
- MCP: `smartsub_media_trim`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub media extract-audio`
- MCP: `smartsub_media_extract_audio`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub media compress`
- MCP: `smartsub_media_compress`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub media gif`
- MCP: `smartsub_media_gif`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub media extract-subtitles`
- MCP: `smartsub_media_extract_subtitles`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub compose run`
- MCP: `smartsub_compose_run`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub compose queue`
- MCP: `smartsub_compose_queue`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub compose encoders`
- MCP: `smartsub_compose_encoders`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub compose fonts`
- MCP: `smartsub_compose_fonts`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub compose presets`
- MCP: `smartsub_compose_presets`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub compose save-preset`
- MCP: `smartsub_compose_save_preset`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub compose delete-preset`
- MCP: `smartsub_compose_delete_preset`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub providers list`
- MCP: `smartsub_providers_list`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub providers types`
- MCP: `smartsub_providers_types`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub providers save`
- MCP: `smartsub_providers_save`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub providers delete`
- MCP: `smartsub_providers_delete`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub providers test`
- MCP: `smartsub_providers_test`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub providers health`
- MCP: `smartsub_providers_health`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub settings get`
- MCP: `smartsub_settings_get`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub settings update`
- MCP: `smartsub_settings_update`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub models list`
- MCP: `smartsub_models_list`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub models install`
- MCP: `smartsub_models_install`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub models delete`
- MCP: `smartsub_models_delete`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub models import`
- MCP: `smartsub_models_import`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub engines list`
- MCP: `smartsub_engines_list`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub engines install`
- MCP: `smartsub_engines_install`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub engines progress`
- MCP: `smartsub_engines_progress`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub engines cancel`
- MCP: `smartsub_engines_cancel`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub engines remove`
- MCP: `smartsub_engines_remove`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub engines import`
- MCP: `smartsub_engines_import`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub tts voices`
- MCP: `smartsub_tts_voices`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub tts synthesize`
- MCP: `smartsub_tts_synthesize`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub dubbing get`
- MCP: `smartsub_dubbing_get`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub dubbing create`
- MCP: `smartsub_dubbing_create`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub dubbing run`
- MCP: `smartsub_dubbing_run`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub dubbing export`
- MCP: `smartsub_dubbing_export`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub dubbing resynthesize`
- MCP: `smartsub_dubbing_resynthesize`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub dubbing edit`
- MCP: `smartsub_dubbing_edit`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub dubbing speaker-voice`
- MCP: `smartsub_dubbing_speaker_voice`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub dubbing speaker-settings`
- MCP: `smartsub_dubbing_speaker_settings`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub dubbing cue-voice`
- MCP: `smartsub_dubbing_cue_voice`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub dubbing media`
- MCP: `smartsub_dubbing_media`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub dubbing borrow-silence`
- MCP: `smartsub_dubbing_borrow_silence`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub voices list`
- MCP: `smartsub_voices_list`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub voices analyze`
- MCP: `smartsub_voices_analyze`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub voices inspect`
- MCP: `smartsub_voices_inspect`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub voices denoise`
- MCP: `smartsub_voices_denoise`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub voices transcribe`
- MCP: `smartsub_voices_transcribe`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub voices create`
- MCP: `smartsub_voices_create`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub voices rename`
- MCP: `smartsub_voices_rename`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub voices delete`
- MCP: `smartsub_voices_delete`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub voices cloud`
- MCP: `smartsub_voices_cloud`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub voices link`
- MCP: `smartsub_voices_link`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub voices status`
- MCP: `smartsub_voices_status`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub voices retrain`
- MCP: `smartsub_voices_retrain`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub voices sample`
- MCP: `smartsub_voices_sample`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub voices export`
- MCP: `smartsub_voices_export`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub voices import`
- MCP: `smartsub_voices_import`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub downloads engines`
- MCP: `smartsub_downloads_engines`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub downloads install`
- MCP: `smartsub_downloads_install`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub downloads check`
- MCP: `smartsub_downloads_check`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub downloads start`
- MCP: `smartsub_downloads_start`
- Properties: Mutation/execution; Asynchronous job

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

- CLI: `smartsub downloads resume`
- MCP: `smartsub_downloads_resume`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub downloads retry`
- MCP: `smartsub_downloads_retry`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub downloads cookies`
- MCP: `smartsub_downloads_cookies`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub downloads import-cookies`
- MCP: `smartsub_downloads_import_cookies`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub downloads delete-cookies`
- MCP: `smartsub_downloads_delete_cookies`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub glossaries list`
- MCP: `smartsub_glossaries_list`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub glossaries create`
- MCP: `smartsub_glossaries_create`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub glossaries update`
- MCP: `smartsub_glossaries_update`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub glossaries delete`
- MCP: `smartsub_glossaries_delete`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub glossaries save-entry`
- MCP: `smartsub_glossaries_save_entry`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub glossaries delete-entry`
- MCP: `smartsub_glossaries_delete_entry`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub glossaries import`
- MCP: `smartsub_glossaries_import`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub glossaries export`
- MCP: `smartsub_glossaries_export`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub recipes list`
- MCP: `smartsub_recipes_list`
- Properties: Read-only; Immediate result

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

- CLI: `smartsub recipes save`
- MCP: `smartsub_recipes_save`
- Properties: Mutation/execution; Immediate result

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

- CLI: `smartsub recipes delete`
- MCP: `smartsub_recipes_delete`
- Properties: Mutation/execution; Immediate result

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
