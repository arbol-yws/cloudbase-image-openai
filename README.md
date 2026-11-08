# cloudbase-image-openai

把腾讯云 CloudBase 的图片生成能力封装成 OpenAI 兼容的 `POST /v1/images/generations` 接口。服务端使用 `@cloudbase/node-sdk` 实际调用 CloudBase 生图模型，不包含 mock/fake 返回。

## 能力概览

| 能力 | 支持情况 |
| --- | --- |
| 模型选择 | `model` 必填，由调用方指定并原样转发给 CloudBase，服务不做模型白名单 |
| 参考图/图生图 | 支持，`image` / `image[]` / `images` 可传公网 URL、`data:image/...;base64,...` 或原始 base64 |
| 多张参考图 | Messages 协议（`hy-image-*`）最多 20 张；旧版协议最多 1 张 |
| 指定尺寸 | 支持 `size: "WIDTHxHEIGHT"`，`auto` 表示交给 CloudBase 自动决定 |
| 一次返回多张 | 支持 `n`，通过多次真实 CloudBase 调用实现 |
| 返回 URL | 支持，直接返回 CloudBase 临时图片 URL |
| 返回 base64 | 支持，服务端下载图片后编码为 `b64_json` |
| `quality` / `style` / `background` / `output_format` / `stream` / `mask` | 不支持，会明确返回 400，而不是静默忽略 |
| multipart/form-data | 不支持，仅接受 `application/json` |

## 模型标识与协议分派

`model` 由调用方传入，服务不做白名单、别名或默认值：**缺少 `model` 返回 400 `model_required`**，其余取值原样转发给 CloudBase。这样上游新增模型时无需改代码。

服务只决定“用哪种协议发送”，规则与具体版本号无关：

| 判定条件 | 协议 | CloudBase provider | 请求形态 | 返回路径 |
| --- | --- | --- | --- | --- |
| `model` 以**小写**前缀 `hy-image-` 开头（区分大小写） | Chat/Messages | `cloudbase` | `messages` 内容块，文本与 `image_url` 混排 | `choices[0].delta.image.url` |
| 其他任意 `model` | 旧版 classic | `hunyuan-image` | `prompt` + `image_urls` / `images` | `data[0].url` |

这是**协议分派，不是模型白名单**：未知模型名同样会被转发，由 CloudBase 决定是否接受。判定刻意区分大小写：旧模型标识是大写的 `HY-Image-...`，不会被误送进 Messages 分支。

旧版协议内部还有一条路由规则：请求带参考图时使用图生图端点（`images/generations`），不带参考图时使用文生图端点（SDK 默认 `images/ar/generations`）。服务按“是否带参考图”判断，不枚举模型版本。

尺寸、prompt 长度、种子范围等属于上游策略，服务只做格式校验（如 `WIDTHxHEIGHT`、整数），其余透传；上游拒绝时会把原始信息映射回 OpenAI 错误结构。

文档中的真实模型标识：

| 模型标识 | 状态 | 能力 | 参考图 | 尺寸 | 返回 |
| --- | --- | --- | --- | --- | --- |
| `hy-image-v3.5-preview` | 当前版本 | 文生图 + 图生图 + 多轮编辑 | ≤20 张，单图 ≤20MB | 宽高 [256, 8192]，面积 ≤4096×4096 | `choices[0].delta.image.url`，12 小时 |
| `HY-Image-3.0-Plus-4090-Tob-v1.0` | 已废弃 | 仅文生图 | 不支持 | `1024x1024`、`1280x720`、`720x1280`、`1280x1280` | `data[0].url`，24 小时 |
| `HY-Image-v3.0-I2I-ToB-v1.0.1` | 已废弃 | 图生图（必须垫图） | 1 张，≤10MB，jpg/jpeg/png | 同上四档 | `data[0].url`，24 小时 |

旧模型已废弃，新接入请使用 `hy-image-v3.5-preview`。

## 前置条件

- Node.js >= 20
- 已开通 CloudBase 环境，并具备生图资源/额度
- CloudBase 环境 ID
- 调用方自带的 CloudBase 服务端 API Key（通过 `Authorization: Bearer <key>` 传入）

## 认证方式

本服务只做中转，不保存调用方凭据：

- 每个请求的 `Authorization: Bearer <CloudBase API Key>` 就是该请求使用的上游凭据，服务按请求构造 CloudBase 客户端。
- 请求头缺失且服务端未配置兜底凭据时，返回 `401 missing_credentials`，提示需要传 CloudBase API Key。
- 服务端可用 `CLOUDBASE_APIKEY` 或 `CLOUDBASE_SECRET_ID` + `CLOUDBASE_SECRET_KEY` 配置兜底凭据；不配置也能启动。
- 客户端按凭据哈希做短时内存缓存（10 分钟，最多 100 个），不落盘、不写日志。

## 启动

启动前必须设置：

- `CLOUDBASE_ENV_ID`：必填

凭据为可选项，仅作为调用方未传 Bearer 时的兜底。缺少环境 ID 时进程会直接退出；没有兜底凭据时服务仍可启动，但调用方必须自带 key。

### 本地 npm 运行

```bash
npm install
CLOUDBASE_ENV_ID=your-env-id \
PORT=8080 \
npm start
```

也可以先 `cp .env.example .env` 并填写 `.env`，然后直接执行 `npm start`。

### docker run

```bash
docker build -t cloudbase-image-openai .
docker run -d --name cloudbase-image-openai \
  -p 8080:8080 \
  -e CLOUDBASE_ENV_ID=your-env-id \
  cloudbase-image-openai
```

如需修改端口，容器内监听端口与映射端口需保持一致，例如：

```bash
docker run -d --name cloudbase-image-openai \
  -p 9000:9000 \
  -e PORT=9000 \
  -e CLOUDBASE_ENV_ID=your-env-id \
  cloudbase-image-openai
```

### docker compose

```bash
cp .env.example .env
# 编辑 .env：至少填写 CLOUDBASE_ENV_ID
docker compose up -d --build
```

`docker-compose.yml` 默认把容器 `8080` 映射到宿主机 `${HOST_PORT:-8080}`，容器内固定监听 `8080`。修改宿主机端口：

```bash
HOST_PORT=9000 docker compose up -d --build
```

### 端口配置

- 本地 npm 运行：用 `PORT` 设置监听端口，默认 `8080`。
- `docker run`：用 `-e PORT=<容器端口> -p <宿主机端口>:<容器端口>` 设置。
- `docker compose`：用 `HOST_PORT` 设置宿主机端口，容器内固定 `8080`。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CLOUDBASE_ENV_ID` | 是 | 无 | CloudBase 环境 ID |
| `CLOUDBASE_APIKEY` | 否 | 无 | 可选兜底：CloudBase 服务端 API Key，优先级高于密钥对 |
| `CLOUDBASE_SECRET_ID` | 否 | 无 | 可选兜底：腾讯云 API `secretId`；也兼容 `TENCENTCLOUD_SECRETID` |
| `CLOUDBASE_SECRET_KEY` | 否 | 无 | 可选兜底：腾讯云 API `secretKey`；也兼容 `TENCENTCLOUD_SECRETKEY` |
| `PORT` | 否 | `8080` | HTTP 监听端口 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `900000` | CloudBase 请求超时，生图可能耗时数分钟 |
| `MAX_N` | 否 | `10` | 单次请求允许的最大 `n` |
| `MAX_CONCURRENCY` | 否 | `3` | `n > 1` 时并发调用 CloudBase 的上限 |
| `REVISE_PROMPT` | 否 | `true` | 旧版 I2I 模型是否默认开启 prompt 改写 |
| `B64_DOWNLOAD_TIMEOUT_MS` | 否 | `60000` | `response_format=b64_json` 时下载图片的超时 |
| `MAX_B64_BYTES` | 否 | `20971520` | base64 响应模式下单张图片的最大字节数 |
| `MAX_BODY_SIZE` | 否 | `32mb` | JSON 请求体大小上限 |

## 请求字段

支持 OpenAI 图片接口的常用字段，另加少量 CloudBase 扩展字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | CloudBase 模型标识，原样转发；缺失返回 400 `model_required` |
| `prompt` | string | 是 | 图片描述 |
| `n` | integer | 否 | 生成数量，默认 `1`，最大 `MAX_N` |
| `size` | string | 否 | `auto` 或 `WIDTHxHEIGHT`，如 `1024x1024` |
| `response_format` | string | 否 | `url`（默认）或 `b64_json` |
| `image` / `image[]` / `images` | string \| string[] | 否 | 参考图，支持公网 http(s) URL、data URL、原始 base64 |
| `seed` | integer | 否 | 固定种子；`n > 1` 时会按序号派生 |
| `session` | string | 否 | 仅 Messages 协议（`hy-image-*`），多轮请求保持一致 |
| `footnote` | string | 否 | 水印，最多 16 个字符 |
| `revise` | boolean | 否 | 仅旧版协议，是否改写 prompt；默认取 `REVISE_PROMPT` |
| `generate_max_pixels` | integer | 否 | 仅 Messages 协议，常用 `1048576`、`2359296`、`4194304` |
| `resize_max_pixels` | integer | 否 | 仅 Messages 协议，参考图送入前缩放到的面积上限 |
| `use_search_tool` | object | 否 | 仅 Messages 协议，形如 `{ "value": true }` |
| `user` | string | 否 | 仅作为调用方标识接收，不传给 CloudBase |

未列出的字段（包括 `quality`、`style`、`background`、`output_format`、`output_compression`、`moderation`、`stream`、`partial_images`、`input_fidelity`、`mask`）会返回 `400 unsupported_parameter`。

## 请求示例

示例中的 `$CLOUDBASE_APIKEY` 是调用方自己的 CloudBase 服务端 API Key，经 `Authorization: Bearer` 透传给上游，服务不保存它。

### 文生图

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy-image-v3.5-preview",
    "prompt": "一只胖胖的橘猫坐在窗台上打盹，水彩风格，温暖色调",
    "size": "1024x1024",
    "n": 1,
    "response_format": "url"
  }'
```

### 图生图（参考图 URL）

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "HY-Image-v3.0-I2I-ToB-v1.0.1",
    "prompt": "将这张照片转换为油画风格",
    "image": "https://example.com/reference.jpg",
    "size": "1024x1024"
  }'
```

### 图生图（多张参考图，使用默认新模型）

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy-image-v3.5-preview",
    "prompt": "参考这两张图的构图和配色，画一只坐在窗台上的猫",
    "image": [
      "https://example.com/style-1.png",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ],
    "size": "2048x2048"
  }'
```

### 返回 base64

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy-image-v3.5-preview",
    "prompt": "赛博朋克风格的未来城市夜景，霓虹灯光，雨夜",
    "response_format": "b64_json"
  }'
```

## 响应示例

`response_format=url`：

```json
{
  "created": 1760000000,
  "data": [
    {
      "url": "https://example.com/generated.jpg",
      "revised_prompt": "改写后的 prompt（旧版 I2I 模型可能返回）"
    }
  ]
}
```

`response_format=b64_json`：

```json
{
  "created": 1760000000,
  "data": [
    {
      "b64_json": "iVBORw0KGgo..."
    }
  ]
}
```

CloudBase 返回的图片 URL 是临时地址（新模型 12 小时、旧模型 24 小时有效）。需要长期保存时请使用 `b64_json`，或在调用后自行下载转存。

## 错误结构

所有错误都返回 OpenAI 风格：

```json
{
  "error": {
    "message": "CloudBase image models do not support `quality`. ...",
    "type": "invalid_request_error",
    "param": "quality",
    "code": "unsupported_parameter"
  }
}
```

状态码映射：

| 场景 | HTTP 状态码 | `code` |
| --- | --- | --- |
| 缺少 `model` | `400` | `model_required` |
| 请求字段/尺寸格式/图片参数非法 | `400` | 具体原因，如 `unsupported_parameter`、`invalid_size`、`too_many_images` |
| 未带 Bearer 且服务端无兜底凭据 | `401` | `missing_credentials` |
| 请求体过大 | `413` | `request_too_large` |
| Content-Type 不是 `application/json` | `415` | `unsupported_media_type` |
| 路由不存在 | `404` | `not_found` |
| CloudBase 鉴权失败 | `502` | `upstream_authentication_error` |
| CloudBase 参数校验失败（上游 400） | `400` | `upstream_invalid_request` |
| CloudBase 内容安全审核失败（上游 422） | `400` | `moderation_blocked` |
| CloudBase 限流 | `429` | `rate_limit_exceeded` |
| CloudBase 5xx | `502` | `upstream_error` |
| CloudBase 超时 | `504` | `upstream_timeout` |
| 下载生成图片失败/超时 | `502` / `504` | `image_download_failed` / `image_download_timeout` |

上游鉴权失败返回 `502`：请求已经带着调用方的 CloudBase API Key 到达网关，失败发生在 CloudBase 侧（key 类型不对、无该环境权限或环境未开通生图），属于上游故障；错误 message 会提示检查 key 类型与环境，但不会包含 key 本身。

## 实现说明

- 按 CloudBase Node SDK 文档使用 `@cloudbase/node-sdk`（`3.18.7`）和 `@cloudbase/ai`（`2.32.0`）。
- 协议分派：`hy-image-*` 走 `ai.createImageModel('cloudbase')` + `messages`，结果读取 `choices[0].delta.image.url`；其他模型走 `ai.createImageModel('hunyuan-image')` + `prompt`/`image_urls`/`images`，结果读取 `data[0].url`。
- 旧模型显式设置 `generateImageSubUrlConfig`：带参考图时走 `images/generations`，否则用 SDK 默认的 `images/ar/generations`。
- `n > 1` 会发起 `n` 次真实 CloudBase 调用，并发数受 `MAX_CONCURRENCY` 限制。
- 请求日志只记录请求 ID、路径、状态码和耗时，不记录 prompt、参考图或任何凭据。
- 上游错误 message 在返回与记录前会做脱敏：Bearer token、`accessKey`/`secretId`/`secretKey`、`tcb-*` 形态的 key 会被替换为 `[redacted]`。
- Node SDK 的 HTTP 请求超时和进程内外层超时都会生效；HTTP Server 的 `requestTimeout` 也会随 `UPSTREAM_TIMEOUT_MS` 调整。

## 安全建议

- 不要把 `.env`、API Key、密钥对提交到 Git。
- 服务不持久化调用方凭据；如配置服务端兜底凭据，请使用最小权限并定期轮换。
- 对外暴露时建议放在反向代理后启用 TLS，并由网关负责访问控制。
- 参考图 URL 由 CloudBase 侧拉取，请确认 URL 可公网访问。

## 参考文档

- [CloudBase 图片生成 Node SDK 调用](https://docs.cloudbase.net/ai/image-model/node-sdk)
- [CloudBase Hy-Image-3.5-preview](https://docs.cloudbase.net/ai/image-model/hy-image-3.5-preview)
- [CloudBase 历史版本（旧模型）](https://docs.cloudbase.net/ai/image-model/legacy-image-model)
- [CloudBase Node SDK 初始化与鉴权](https://docs.cloudbase.net/api-reference/server/node-sdk/initialization)
- [CloudBase Node SDK AI 参考](https://docs.cloudbase.net/api-reference/server/node-sdk/ai)
