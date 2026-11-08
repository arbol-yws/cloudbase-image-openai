# cloudbase-image-openai

把腾讯云 CloudBase 的图片生成能力封装成 OpenAI 兼容的 `POST /v1/images/generations` 接口。服务端使用 `@cloudbase/node-sdk` 实际调用 CloudBase 生图模型，不包含 mock/fake 返回。

## 能力概览

| 能力 | 支持情况 |
| --- | --- |
| 文生图 | 支持（默认模型 `hy-image-v3.5-preview`） |
| 参考图/图生图 | 支持，`image` / `image[]` / `images` 可传公网 URL、`data:image/...;base64,...` 或原始 base64 |
| 多张参考图 | `hy-image-v3.5-preview` 最多 20 张；旧版 I2I 模型最多 1 张 |
| 指定尺寸 | 支持 `size: "WIDTHxHEIGHT"`，`auto` 表示交给 CloudBase 自动决定 |
| 一次返回多张 | 支持 `n`，通过多次真实 CloudBase 调用实现 |
| 返回 URL | 支持，直接返回 CloudBase 临时图片 URL |
| 返回 base64 | 支持，服务端下载图片后编码为 `b64_json` |
| `quality` / `style` / `background` / `output_format` / `stream` / `mask` | 不支持，会明确返回 400，而不是静默忽略 |
| multipart/form-data | 不支持，仅接受 `application/json` |

## 模型映射

服务按请求中的 `model` 解析到 CloudBase 模型，匹配不区分大小写。未传 `model` 时使用 `DEFAULT_MODEL`，传 `auto` 也会回退到默认模型。

| 请求 model | CloudBase 模型 | CloudBase provider | 说明 |
| --- | --- | --- | --- |
| `hy-image-v3.5-preview`、`cloudbase`、`cloudbase-image`、`cloudbase-image-3.5`、`gpt-image-1`、`gpt-image-1.5`、`dall-e-3`、`dall-e-2` | `hy-image-v3.5-preview` | `cloudbase` | 当前模型；支持文本 + 最多 20 张参考图；URL 有效期 12 小时 |
| `cloudbase-i2i`、`cloudbase-image-i2i`、`hunyuan-image-i2i`、`HY-Image-v3.0-I2I-ToB-v1.0.1` | `HY-Image-v3.0-I2I-ToB-v1.0.1` | `hunyuan-image` | 旧版 I2I 模型；必须传参考图；最多 1 张；URL 有效期 24 小时 |

可以用 `MODEL_MAP` 增加别名：

```bash
MODEL_MAP='{"my-image-model":"hy-image-v3.5-preview","my-i2i":"HY-Image-v3.0-I2I-ToB-v1.0.1"}'
```

`MODEL_MAP` 的值必须是上表中的 CloudBase 模型名，否则服务启动失败。

### 尺寸约束

- `hy-image-v3.5-preview`：宽、高均在 `[256, 8192]`，面积不超过 `4096x4096`。
- `HY-Image-v3.0-I2I-ToB-v1.0.1`：宽、高均在 `[512, 2048]`，面积不超过 `1024x1024`。例如 OpenAI 常用的 `1792x1024` 不适用于该旧模型。

## 前置条件

- Node.js >= 20
- 已开通 CloudBase 环境，并具备生图资源/额度
- CloudBase 环境 ID
- 鉴权凭据，二选一：
  - 推荐：CloudBase 服务端 API Key（`CLOUDBASE_APIKEY`）
  - 或者：腾讯云 API 密钥对（`CLOUDBASE_SECRET_ID` + `CLOUDBASE_SECRET_KEY`）

## 启动

启动前必须设置：

- `CLOUDBASE_ENV_ID`：必填
- 凭据二选一：`CLOUDBASE_APIKEY`，或 `CLOUDBASE_SECRET_ID` + `CLOUDBASE_SECRET_KEY`

缺少环境 ID 或鉴权凭据时，进程会直接退出，不会启动一个不可用的服务。

### 本地 npm 运行

```bash
npm install
CLOUDBASE_ENV_ID=your-env-id \
CLOUDBASE_APIKEY=your-api-key \
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
  -e CLOUDBASE_APIKEY=your-api-key \
  cloudbase-image-openai
```

如需修改端口，容器内监听端口与映射端口需保持一致，例如：

```bash
docker run -d --name cloudbase-image-openai \
  -p 9000:9000 \
  -e PORT=9000 \
  -e CLOUDBASE_ENV_ID=your-env-id \
  -e CLOUDBASE_APIKEY=your-api-key \
  cloudbase-image-openai
```

### docker compose

```bash
cp .env.example .env
# 编辑 .env：填写 CLOUDBASE_ENV_ID 和凭据
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
| `CLOUDBASE_APIKEY` | 二选一 | 无 | CloudBase 服务端 API Key，优先级高于密钥对 |
| `CLOUDBASE_SECRET_ID` | 二选一 | 无 | 腾讯云 API `secretId`；也兼容 `TENCENTCLOUD_SECRETID` |
| `CLOUDBASE_SECRET_KEY` | 二选一 | 无 | 腾讯云 API `secretKey`；也兼容 `TENCENTCLOUD_SECRETKEY` |
| `PORT` | 否 | `8080` | HTTP 监听端口 |
| `ADAPTER_API_KEY` | 否 | 空 | 调用方 Bearer Token；为空时接口不校验调用方身份 |
| `DEFAULT_MODEL` | 否 | `hy-image-v3.5-preview` | 请求未传 `model` 时使用的模型 |
| `MODEL_MAP` | 否 | `{}` | 额外模型别名，JSON 对象 |
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
| `model` | string | 否 | 模型别名；缺省使用 `DEFAULT_MODEL` |
| `prompt` | string | 是 | 图片描述 |
| `n` | integer | 否 | 生成数量，默认 `1`，最大 `MAX_N` |
| `size` | string | 否 | `auto` 或 `WIDTHxHEIGHT`，如 `1024x1024` |
| `response_format` | string | 否 | `url`（默认）或 `b64_json` |
| `image` / `image[]` / `images` | string \| string[] | 否 | 参考图，支持公网 http(s) URL、data URL、原始 base64 |
| `seed` | integer | 否 | 固定种子；`n > 1` 时会按序号派生 |
| `session` | string | 否 | 仅 `hy-image-v3.5-preview`，多轮请求保持一致 |
| `footnote` | string | 否 | 水印，最多 16 个字符 |
| `revise` | boolean | 否 | 仅旧版 I2I 模型，是否改写 prompt；默认取 `REVISE_PROMPT` |
| `generate_max_pixels` | integer | 否 | 仅 `hy-image-v3.5-preview`，可选 `1048576`、`2359296`、`4194304` |
| `user` | string | 否 | 仅作为调用方标识接收，不传给 CloudBase |

未列出的字段（包括 `quality`、`style`、`background`、`output_format`、`output_compression`、`moderation`、`stream`、`partial_images`、`input_fidelity`、`mask`）会返回 `400 unsupported_parameter`。

## 请求示例

### 文生图

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-1",
    "prompt": "一只胖胖的橘猫坐在窗台上打盹，水彩风格，温暖色调",
    "size": "1024x1024",
    "n": 1,
    "response_format": "url"
  }'
```

### 图生图（参考图 URL）

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloudbase-i2i",
    "prompt": "将这张照片转换为油画风格",
    "image": "https://example.com/reference.jpg",
    "size": "1024x1024"
  }'
```

### 图生图（多张参考图，使用默认新模型）

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
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
  -H "Authorization: Bearer $ADAPTER_API_KEY" \
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
| 请求字段/尺寸/图片参数非法 | `400` | 具体原因，如 `unsupported_parameter`、`unsupported_size`、`missing_reference_image` |
| 调用方 Bearer Token 缺失或错误 | `401` | `missing_api_key` / `invalid_api_key` |
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

上游鉴权失败返回 `502` 而不是 `401`：调用方的 Bearer Token 可能是正确的，真正失败的是服务端配置的 CloudBase 凭据，属于网关上游故障。

## 实现说明

- 按 CloudBase Node SDK 文档使用 `@cloudbase/node-sdk`（锁定 `3.18.7`）和 `@cloudbase/ai`（`2.32.0`）。
- `hy-image-v3.5-preview` 通过 `ai.createImageModel('cloudbase')` 调用，参数为 `messages`（文本 + 参考图 content parts），结果读取 `choices[0].delta.image.url`。
- 旧版 I2I 通过 `ai.createImageModel('hunyuan-image')` 调用，参数为 `prompt` + `image_urls` 或 `images`，结果读取 `data[0].url`。
- `n > 1` 会发起 `n` 次真实 CloudBase 调用，并发数受 `MAX_CONCURRENCY` 限制。
- 服务端不会把请求日志中的 prompt、参考图或凭据写入日志；请求日志只记录请求 ID、路径、状态码和耗时。
- Node SDK 的 HTTP 请求超时和进程内外层超时都会生效；HTTP Server 的 `requestTimeout` 也会随 `UPSTREAM_TIMEOUT_MS` 调整。

## 安全建议

- 不要把 `.env`、API Key、密钥对提交到 Git。
- 对外暴露时建议在反向代理后启用 TLS，并设置 `ADAPTER_API_KEY`。
- CloudBase API Key 和腾讯云密钥对只应有生图所需的最小权限，并定期轮换。
- 参考图 URL 由 CloudBase 侧拉取；不要在公网暴露本服务而未加鉴权。

## 参考文档

- [CloudBase 图片生成 Node SDK 调用](https://docs.cloudbase.net/ai/image-model/node-sdk)
- [CloudBase Hy-Image-3.5-preview](https://docs.cloudbase.net/ai/image-model/hy-image-3.5-preview)
- [CloudBase 历史版本（旧模型）](https://docs.cloudbase.net/ai/image-model/legacy-image-model)
- [CloudBase Node SDK 初始化与鉴权](https://docs.cloudbase.net/api-reference/server/node-sdk/initialization)
- [CloudBase Node SDK AI 参考](https://docs.cloudbase.net/api-reference/server/node-sdk/ai)
