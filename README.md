# cloudbase-image-openai

把腾讯云 CloudBase 的图片生成能力包装成 OpenAI Images API 兼容的 `POST /v1/images/generations` 中转服务。请求发给本服务，服务实际调用 CloudBase 生图接口，再按 OpenAI 结构返回。

## 支持的接口类型

`model` 原样透传，服务不映射模型名；可用模型见 [CloudBase 图片生成文档](https://docs.cloudbase.net/ai/image-model/overview)。

- **CloudBase Messages 协议（新版）**：`model` 以小写前缀 `hy-image-` 开头时走这条。图片从 `choices[0].delta.image.url` 取。文档：[CloudBase Messages 协议](https://docs.cloudbase.net/ai/image-model/hy-image-3.5-preview)
- **旧版图像接口**：其他 `model` 走这条。图片从 `data[0].url` 取。文档：[历史版本（旧模型）](https://docs.cloudbase.net/ai/image-model/legacy-image-model)

## 启动

```bash
npm install
CLOUDBASE_ENV_ID=your-env-id npm start
```

服务不会自动读取 `.env`。需要用 `.env` 时先在当前 shell 导出：

```bash
cp .env.example .env
set -a && . ./.env && set +a
npm start
```

Docker：

```bash
docker build -t cloudbase-image-openai .
docker run -d --name cloudbase-image-openai -p 8080:8080 \
  -e CLOUDBASE_ENV_ID=your-env-id \
  cloudbase-image-openai
```

Docker Compose（会自动读取 `.env`）：

```bash
cp .env.example .env
# 至少填写 CLOUDBASE_ENV_ID
docker compose up -d --build
```

环境变量：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CLOUDBASE_ENV_ID` | 是 | 无 | CloudBase 环境 ID |
| `CLOUDBASE_APIKEY` | 否 | 无 | 调用方未传 Bearer 时的兜底凭据 |
| `PORT` | 否 | `8080` | HTTP 监听端口 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `900000` | CloudBase 请求超时 |

## 使用说明

鉴权：每个请求都带 `Authorization: Bearer <CloudBase API Key>`。`<your-model>` 的取值见上面的 CloudBase 文档。

文生图：

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<your-model>",
    "prompt": "一只在沙滩上奔跑的金毛犬，傍晚的暖色光"
  }'
```

图生图（`image` 支持公网 URL、data URL 或裸 base64）：

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<your-model>",
    "prompt": "参考这张图，画一只坐在窗台上的橘猫，水彩风格",
    "image": "https://example.com/reference.jpg"
  }'
```

请求字段：`model`、`prompt` 必填；`n`、`size`、`response_format`（`url` 或 `b64_json`）、`image` 可选。

成功响应：

```json
{
  "created": 1760000000,
  "data": [{ "url": "https://example.com/generated.jpg" }]
}
```

使用 `response_format=b64_json` 时，`data[0].b64_json` 会替代 `url`。

## 错误响应

失败时保持 OpenAI 错误结构，`message` 为上游返回的原文：

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
