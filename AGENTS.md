# 视觉桥接技能包（本目录）

本目录是 dsh-vision-bridge-skill 技能包：把 dsh web 会话变成“图片 → 其他 VLM 识图 → DeepSeek 输出”的路由。

## 使用约定

- 一切操作以 `README.md` 为准（安装、配置、验证、回滚、排错）。
- 安装优先用 `scripts/install.ps1`；无法运行脚本时严格按 README 手动步骤执行。
- 凭据：`DASHSCOPE_API_KEY` 写入 `<DSH_HOME>/.credentials.yaml` 或注入环境变量，Key 只允许掩码回显（末 4 位）。
- 重启语义（与 README「重启」章节一致）：**插件代码**改动必须重启 `dsh web`；**补丁文件 / `settings.yaml`** 改动通常被 HMR 热加载，拿不准时一律重启最稳妥。本技能目录内的文件改动不影响运行中的服务器。

## 安全红线

- 绝不把真实 API Key 写入本目录任何文件、输出到终端或提交到 git。
- 发布前检查 `.gitignore` 与全目录是否存在真实 Key（搜索 `sk-` 前缀，排除 `.env.example` 占位符）。
