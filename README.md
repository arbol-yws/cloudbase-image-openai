# cloudbase-image-openai

把腾讯云 CloudBase 的图片生成能力封装成 OpenAI 兼容的 `POST /v1/images/generations` 接口。服务用 `@cloudbase/node-sdk` 实际调用 CloudBase 生图模型，不包含 mock/fake 返回。

核心只有三步：接收 OpenAI 请求 → 调用 CloudBase → 按 OpenAI 结构返回。服务不复制 CloudBase 的模型策略：除“有参考图但未传 `size` 时按参考图比例换算尺寸”外，尺寸具体取值、prompt 长度、参考图数量、图片类型等均由上游判定。

## 两条协议

| 判定 | 协议 | CloudBase provider | 请求形态 | 返回路径 |
| --- | --- | --- | --- | --- |
| `model` 以**小写**前缀 `hy-image-` 开头，或等于 `hy-image-v3.5-preview` | Messages | `cloudbase` | `messages` 内容块，文本与 `image_url` 混排 | `choices[0].delta.image.url` |
| 其他任意 `model` | 旧版 | `hunyuan-image` | `prompt` + `image_urls` / `images` | `data[0].url` |

`model` 原样转发，不做白名单、别名或默认值。分派同时使用“文档模型精确匹配 + 大小写敏感的前缀兜底”，大写旧模型（`HY-Image-...`）不会被误送进 Messages 分支。未知小写 `hy-image-*` 会走 Messages，未知其他模型走旧版，是否接受由 CloudBase 决定。

旧版协议始终使用 SDK 默认端点 `images/ar/generations`；服务不覆盖 `generateImageSubUrlConfig`，也不根据“是否带参考图”切换端点。参考图按文档映射：Messages 把文本和 `image_url`（URL 或 data URL）混排进 `messages` 内容块；旧版把 URL 映射为 `image_urls`，把 base64/data URL 映射为 `images`。张数、类型、大小由 CloudBase 判定。

### 文档模型

| 模型标识 | 状态 | 能力 | 参考图 | 尺寸 | 返回 |
| --- | --- | --- | --- | --- | --- |
| `hy-image-v3.5-preview` | 当前版本 | 文生图 + 图生图 + 多轮编辑 | ≤20 张，单图 ≤20MB | 宽高 [256, 8192]，面积 ≤4096×4096 | `choices[0].delta.image.url`，12 小时 |
| `HY-Image-3.0-Plus-4090-Tob-v1.0` | 已废弃 | 仅文生图 | 不支持 | `1024x1024`、`1280x720`、`720x1280`、`1280x1280` | `data[0].url`，24 小时 |
| `HY-Image-v3.0-I2I-ToB-v1.0.1` | 已废弃 | 图生图（必须垫图） | 1 张，≤10MB，jpg/jpeg/png | 同上四档 | `data[0].url`，24 小时 |

上表是文档约束。服务只做字段类型、凭据、`model` 等必需校验，其余交给 CloudBase 判定。新接入优先使用 `hy-image-v3.5-preview`。

## 前置条件

- Node.js >= 20
- 已开通 CloudBase 环境，并具备生图资源/额度
- CloudBase 环境 ID
- 调用方自带的 CloudBase 服务端 API Key（`Authorization: Bearer <key>`）
- 环境里启用了对应生图模型

## 认证方式

- 每个请求的 `Authorization: Bearer <CloudBase API Key>` 就是该请求使用的上游凭据；`Bearer` 只是 HTTP 认证方案前缀。
- 只接受这一种格式，且只从请求头读取；缺少 `Bearer ` 前缀或前缀后为空都返回 401 `missing_credentials`，message 中说明正确格式。
- 服务端可用 `CLOUDBASE_APIKEY` 或 `CLOUDBASE_SECRET_ID` + `CLOUDBASE_SECRET_KEY` 配置兜底凭据；不配置也能启动。
- 服务不缓存、不落盘、不记录调用方凭据。

## 启动

启动前必须设置 `CLOUDBASE_ENV_ID`；凭据可选，仅作为调用方未传 Bearer 时的兜底。

### 本地 npm 运行

```bash
npm install
CLOUDBASE_ENV_ID=your-env-id PORT=8080 npm start
```

也可以使用 `.env` 文件，但要注意：`npm start` 本身不加载 `.env`，需要在当前 shell 导出变量：

```bash
cp .env.example .env
set -a && . ./.env && set +a
npm start
```

`.env` 会被下面的 `docker compose` 自动读取。

健康检查：`GET /health` 返回 `{"status":"ok"}`，`docker-compose.yml` 用它做容器健康检查。

### docker run

```bash
docker build -t cloudbase-image-openai .
docker run -d --name cloudbase-image-openai \
  -p 8080:8080 \
  -e CLOUDBASE_ENV_ID=your-env-id \
  cloudbase-image-openai
```

### docker compose

```bash
cp .env.example .env
# 编辑 .env：至少填写 CLOUDBASE_ENV_ID
docker compose up -d --build
```

`docker-compose.yml` 默认把容器 `8080` 映射到宿主机 `${HOST_PORT:-8080}`。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CLOUDBASE_ENV_ID` | 是 | 无 | CloudBase 环境 ID；也兼容 `TCB_ENV` |
| `CLOUDBASE_APIKEY` | 否 | 无 | 可选兜底：CloudBase 服务端 API Key |
| `CLOUDBASE_SECRET_ID` | 否 | 无 | 可选兜底：腾讯云 API `secretId`；也兼容 `TENCENTCLOUD_SECRETID` |
| `CLOUDBASE_SECRET_KEY` | 否 | 无 | 可选兜底：腾讯云 API `secretKey`；也兼容 `TENCENTCLOUD_SECRETKEY` |
| `PORT` | 否 | `8080` | HTTP 监听端口 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `900000` | CloudBase 请求超时 |
| `MAX_N` | 否 | `10` | 单次请求允许的最大 `n`（服务自身容量限制） |
| `REVISE_PROMPT` | 否 | `true` | 旧版 I2I 模型默认是否开启 prompt 改写 |
| `B64_DOWNLOAD_TIMEOUT_MS` | 否 | `60000` | `response_format=b64_json` 时下载图片的超时 |
| `MAX_B64_BYTES` | 否 | `20971520` | base64 响应模式下单张图片的最大字节数 |
| `MAX_BODY_SIZE` | 否 | `32mb` | JSON 请求体大小上限 |

## 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | CloudBase 模型标识，原样转发；缺失返回 400 `model_required` |
| `prompt` | string | 是 | 图片描述 |
| `n` | integer | 否 | 生成数量，默认 `1`，最大 `MAX_N` |
| `size` | string | 否 | 显式传入时原样透传；省略且带参考图时按参考图宽高比换算（见下文「水印与尺寸」） |
| `response_format` | string | 否 | `url`（默认）或 `b64_json` |
| `image` / `image[]` / `images` | string \| string[] | 否 | 参考图扩展，支持公网 http(s) URL、data URL、原始 base64 |
| `seed` | integer | 否 | 透传给 CloudBase；`n > 1` 时按序号派生 |
| `revise` | boolean | 否 | 仅旧版协议，是否改写 prompt；默认取 `REVISE_PROMPT` |

只做字段存在性与类型检查。除“未传 `size` 且带参考图时按比例换算”外，`size` 的具体取值、prompt 长度、参考图数量和类型、`seed` 范围等均由 CloudBase 判定。未列出的字段会被忽略，不额外返回 400。

## 水印与尺寸

### 水印

两条协议都只有一个水印字段 `footnote`（string，可选，最长 16 字符，生成在图片右下角），没有 `watermark` / `logo_add` 之类的布尔或数字开关。服务对每次 CloudBase 调用都发送 `footnote: " "`（单个空格）。

为什么是空格而不是空字符串：

- 用户实测确认上游拒绝 `footnote: ""`，空串不受支持。
- 实测反馈：空格视觉上等同无水印，不替换默认标识；该表现需以实际输出为准。
- 该效果需以实测为准；上游若对空格也报错，原因会直接出现在响应 `error.message` 里。

- SDK 类型定义：`@cloudbase/ai` 的 `CloudbaseGenerateImageInput.footnote?: string`（Messages）与 `HunyuanARGenerateImageInput.footnote?: string`（旧版），见 `node_modules/@cloudbase/ai/src/type.ts`。
- 官方文档：`footnote` 是「自定义水印内容」，两条协议各自列出该字段；文档没有规定最小长度，也没有单独的“关闭水印”参数。
- 微信云开发文档说明 `footnote` 是水印文本，会替换输出图片右下角默认的「AI生成」标识；空格的实际表现与文档描述可能不同，以实测为准。

### 尺寸

- 调用方显式传 `size`：原样透传，保持 OpenAI 语义。
- 未传 `size` 且有参考图：读取第一张参考图的宽高，按实际宽高比换算出文档支持的 `size`。
- 两条协议都没有 `aspect_ratio` 字段，因此只能用 `size`（`${宽}x${高}`）表达比例。

| 协议 | 换算规则 | 示例（参考图 1600×900） |
| --- | --- | --- |
| Messages | 按参考图比例缩放到 1.5K 面积档（文档 `generate_max_pixels` 默认 `2359296`），宽高限制在 [256, 8192]、面积不超过 4096×4096 | `size: "2048x1152"` |
| 旧版 | 从文档四档 `1024x1024`、`1280x720`、`720x1280`、`1280x1280` 中选宽高比最接近的一档 | `size: "1280x720"` |

参考图尺寸读取方式：

- base64 / data URL：直接解析 PNG / JPEG / WebP 文件头。
- 公网 URL：服务端只读取图片头部（最多 256KB、8 秒超时、不跟随重定向），并通过 DNS 解析限制只访问公网地址，避免 SSRF。读不到尺寸时不传 `size`，交回 CloudBase 决定。

## 请求示例

示例中的 `$CLOUDBASE_APIKEY` 是调用方自己的 CloudBase 服务端 API Key，服务不保存它。

### Messages 协议：`hy-image-v3.5-preview` 图生图

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy-image-v3.5-preview",
    "prompt": "参考这张图，画一只坐在窗台上的橘猫，水彩风格",
    "image": "https://example.com/reference.jpg",
    "size": "1024x1024",
    "n": 1,
    "response_format": "url"
  }'
```

文生图时去掉 `image` 字段即可。

### 旧版协议：`HY-Image-v3.0-I2I-ToB-v1.0.1` 图生图

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

`image` 换成 data URL 或原始 base64 时，旧版协议会把它放进 `images` 字段。

两条示例都显式传了 `size`。如果要让输出跟随参考图比例，去掉 `size` 即可，服务会按上面的规则换算。

## 响应

成功响应严格保持 OpenAI 结构，不增加额外字段：

`response_format=url`：

```json
{
  "created": 1760000000,
  "data": [
    { "url": "https://example.com/generated.jpg" }
  ]
}
```

`response_format=b64_json`：

```json
{
  "created": 1760000000,
  "data": [
    { "b64_json": "iVBORw0KGgo..." }
  ]
}
```

CloudBase 返回的是临时 URL（新模型 12 小时、旧模型 24 小时有效）。需要长期保存时使用 `b64_json` 或调用后自行转存。

## 错误结构

失败响应严格保持 OpenAI 错误对象，只有四个字段：

```json
{
  "error": {
    "message": "images must contain 1 item",
    "type": "invalid_request_error",
    "param": null,
    "code": "upstream_invalid_request"
  }
}
```

`error.message` 的取值规则：

- 上游有错误内容时，直接使用上游返回的原始 message，不追加前缀、状态码、request_id，也不加本服务的解释。
- 上游 message 为空时，使用上游返回的 code。
- 上游完全没有错误内容（例如只有 HTTP 状态码）时，用一句简短说明，例如 `CloudBase returned HTTP 400 without an error message.`。
- 上游返回成功但没有图片时，`CloudBase returned HTTP 200 without an image.`。
- 文本最多 800 字符，超出追加 `... [truncated]`；`Bearer` token、`accessKey`/`secretId`/`secretKey`、`tcb-*` 形态的 key 替换为 `[redacted]`。
- 上游 request_id 只写日志，不出现在响应里。

服务端日志：

- 每个请求只有一行 `http_request`：`request_id`、`method`、`path`、`status`、`duration_ms`、`upstream_request_id`（来自 CloudBase 响应头）。
- 不输出上游原始响应体：上游原文已经在响应的 `error.message` 里，request_id 在日志里。
- 只有未捕获异常（服务自身 bug）才额外记录 `unhandled_error` / `uncaught_exception`，带 `request_id` 和完整 `stack`（脱敏）；stack 不会返回给调用方。
- 抓取方式不变：包装 SDK 的 `tcbopenapicommonrequester.request`，在传输边界拿到 `{ statusCode, headers, body }`，用 `AsyncLocalStorage` 按请求隔离；body 只用于生成 `error.message`。

状态码映射：

| 场景 | HTTP 状态码 | `code` |
| --- | --- | --- |
| 请求体不是 JSON 对象 | `400` | `invalid_request_body` |
| 缺少 `model` / `prompt` | `400` | `model_required` / `invalid_prompt` |
| `n` / `response_format` / `size` / `seed` 类型或取值错误 | `400` | `invalid_n` / `invalid_response_format` / `invalid_size` / `invalid_seed` |
| 参考图不是 URL、data URL 或 base64 | `400` | `invalid_image` |
| JSON 解析失败 | `400` | `invalid_json` |
| `multipart/form-data` 请求 | `400` | `unsupported_content_type` |
| 未带 Bearer 且服务端无兜底凭据 | `401` | `missing_credentials` |
| 路由不存在 | `404` | `not_found` |
| 请求体过大 | `413` | `request_too_large` |
| Content-Type 不是 `application/json` | `415` | `unsupported_media_type` |
| CloudBase 鉴权/环境权限失败 | `502` | `upstream_authentication_error` |
| CloudBase 参数校验失败（上游 400） | `400` | `upstream_invalid_request` |
| CloudBase SDK 本地参数校验失败 | `400` | `invalid_parameter` |
| CloudBase 内容安全审核失败（上游 422） | `400` | `moderation_blocked` |
| CloudBase 限流 | `429` | `rate_limit_exceeded` |
| CloudBase 返回成功但没有图片 | `502` | `upstream_empty_response` |
| CloudBase 其他失败 | `502` | `upstream_error` |
| CloudBase 超时 | `504` | `upstream_timeout` |
| 下载生成图片失败/超时 | `502` / `504` | `image_download_failed` / `image_download_timeout` |
| b64 图片超过 `MAX_B64_BYTES` | `502` | `image_too_large_for_b64` |
| 未捕获异常 | `500` | `internal_error` |

环境里没有对应模型时，上游通常返回 400（参数或模型不支持）或 403（模型/环境权限）。具体原因直接看响应 `error.message`（上游原文）；request_id 在服务端 `http_request` 日志里。

## 上游探针

`scripts/probe-legacy.js` 不经过 SDK 发送请求，直接对 SDK 推导出的真实端点发原始 HTTP，打印状态码、响应头和原始响应体：

```bash
node scripts/probe-legacy.js \
  --env your-env-id \
  --key "$CLOUDBASE_APIKEY" \
  --image-url https://example.com/reference.jpg
```

脚本默认对三种请求形态各发一次：`image_urls`、`images`（base64）、仅 prompt 的文生图。`image_urls` 形态需要传一个可公网访问的 `--image-url`，否则会跳过该形态。key 只从参数或 `CLOUDBASE_APIKEY` 读取，不打印完整 key。端点来源：`@cloudbase/node-sdk` 的网关 `ai.baseUrl` 加 `@cloudbase/ai` 的默认 `images/ar/generations`。

## 实现说明

- 使用 `@cloudbase/node-sdk`（`3.18.7`）和 `@cloudbase/ai`（`2.32.0`）。
- Messages 分支：`ai.createImageModel('cloudbase')`，参考图放进 `messages` 内容块，结果读 `choices[0].delta.image.url`。
- 旧版分支：`ai.createImageModel('hunyuan-image')`，结果读 `data[0].url`，端点由 SDK 决定。
- `n > 1` 会发起 `n` 次真实 CloudBase 调用。
- 请求日志只记录请求 ID、method、path、状态码、耗时和上游 request_id，不记录 prompt、参考图、上游响应体或凭据。

## 安全建议

- 不要把 `.env`、API Key、密钥对提交到 Git。
- 服务不持久化调用方凭据；如配置服务端兜底凭据，请使用最小权限并定期轮换。
- 对外暴露时建议放在反向代理后启用 TLS，并由网关负责访问控制。
- 参考图 URL 主要由 CloudBase 侧拉取；服务为了换算尺寸会额外读取一次图片头部（只读头部、限制公网地址）。请确认 URL 可公网访问。

## 参考文档

- [CloudBase 图片生成 Node SDK 调用](https://docs.cloudbase.net/ai/image-model/node-sdk)
- [CloudBase Hy-Image-3.5-preview](https://docs.cloudbase.net/ai/image-model/hy-image-3.5-preview)
- [CloudBase 自定义水印](https://docs.cloudbase.net/ai/image-model/custom-watermark)
- [CloudBase 历史版本（旧模型）](https://docs.cloudbase.net/ai/image-model/legacy-image-model)
- [微信云开发 AI 客户端 API（footnote）](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/extend/ai/client.html)
- [CloudBase Node SDK 初始化与鉴权](https://docs.cloudbase.net/api-reference/server/node-sdk/initialization)
- [CloudBase Node SDK AI 参考](https://docs.cloudbase.net/api-reference/server/node-sdk/ai)
