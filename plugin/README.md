# dsh-llm-vision-bridge

DeepSeek 适配器包装插件（dsh web profile 用）：模型请求里的图片块先由 OpenAI 兼容视觉 API（默认 DashScope `qwen-vl-max`）转成文字描述，再把纯文本请求交给 DeepSeek。

- 注册 provider `deepseek-official`（需在 profile patch 里禁用官方 `llm-deepseek` 行避免冲突）
- 会话模型保持 `deepseek-v4-flash`，聊天框粘贴/拖拽发图自动生效
- 描述按附件 sha256 缓存（内存 + `<DSH_HOME>/attachments/v1/descriptions/<sha256>.json`），每张图只描述一次

## 包含的两处关键修复

1. **模型目录默认值**：`Config.models` 带 `.default(DEFAULT_MODELS)`（与官方插件一致），避免 schemastery 归一化出空数组导致模型选择器只剩一个模型。
2. **图片输入声明**：`resolveModel` 把 `inputModalities` 声明为 `["text", "image"]`，否则 dsh web 网关会在发送前以 "Model does not support image input" 拒绝带图消息。

## 安装

见上级目录 `README.md`（推荐用 `scripts/install.ps1`）。要点：

1. 把本包复制到 `<DSH_HOME>/profiles/node_modules/dsh-llm-vision-bridge/`
2. `profiles/web/cordis.patch.yml` **整文件替换**为（注意删掉原 `[]` 行）：

```yaml
- id: llm-deepseek
  disabled: true
- insert:
    - id: llm-vision-bridge
      name: 'dsh-llm-vision-bridge'
```

3. 配置 `DASHSCOPE_API_KEY`（写入 `<DSH_HOME>/.credentials.yaml` 或环境变量）
4. 重启 `dsh web`

## 配置（可选，均为默认值）

```yaml
llm-vision-bridge:
  apiKeyEnv: DEEPSEEK_API_KEY       # DeepSeek 对话 Key 的凭据引用
  baseURL: https://api.deepseek.com
  models:
    - id: deepseek-v4-flash
    - id: deepseek-v4-pro
  vision:
    apiKeyEnv: DASHSCOPE_API_KEY    # 识图 Key 的凭据引用
    baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
    model: qwen-vl-max
    maxTokens: 1024
    timeoutMs: 60000
    descriptionPrompt: 请用中文详细描述这张图片的内容，包括其中的文字、布局、颜色和所有可辨识的细节，供一个只能阅读文字的模型理解。
```

## 安全

插件本身不存储任何 Key；Key 在每次请求时经凭据服务解析。绝不把真实 Key 写入本目录或提交到 git（见上级 `.gitignore` 与 README 安全红线）。
