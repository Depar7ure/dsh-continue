# dsh-continue

> DeepSeek Harness 的中断对话恢复插件：对话因暂停、崩溃、超时或网络错误中断后，在发送按钮左侧显示圆形 `>|` 按钮，一键接续或重试。

## 核心能力

- **四种中断识别**：手动暂停、Host 崩溃留下的未闭合轮次、模型超时、网络/传输错误。
- **一键恢复**：点击 `>|` 按钮，默认接续现有进度；也可配置为重试（重新提交上一条用户输入）。
- **双通道**：`/continue-session` 命令与 `continue_session` agent 工具共用同一 Host 恢复方法。
- **状态可靠**：基于会话日志的纯增量投影，冷启动全量重放，页面刷新或 Harness 重启不丢失中断状态。
- **零依赖**：无额外 npm 依赖、无安装脚本、无构建步骤，Host 依赖复用 Harness 自带模块。

## 安装

本插件是一个 Cordis bundle，`package.json` 声明了 `dsh.bundle` manifest，根目录携带 `cordis.patch.yml`。

从本仓库打包后在 Harness 内安装：

```sh
pnpm pack --out dsh-continue.tgz
```

随后在 DeepSeek Harness 中用 `plugin_manager` 的 `install_bundle`，`target` 指向打包出的 `.tgz` 路径。安装完成后完整重启 Harness（插件管理器会返回 `restart-required`）。

也可以通过 DSH 插件市场或 `dsh plugin add` 从本仓库安装。

## 配置

插件包名 `@local/continue-plugin`，插件行 `local-continue-plugin`。配置项：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `strategy` | `continue` | 点击按钮采用的策略：`continue`（接续）/ `retry`（重试）/ `auto`（超时与网络错误自动重试，其余接续） |
| `continuePrompt` | 中文接续提示 | `continue` 模式提交给模型的提示词 |

使用 Plugin Manager 的配置入口或正常的用户 patch 覆盖配置；升级时用户覆盖层保留。

## 使用

- 对话中断且当前会话空闲时，发送按钮左侧出现 34×34 的圆形 `>|` 按钮，单击提交恢复请求。
- 正常完成、正在生成、父代理管理的子会话不显示按钮。
- `/continue-session` 使用默认策略；`/continue-session retry` 重试上一条用户输入；`/continue-session auto` 自动选择。
- agent 工具 `continue_session` 使用相同 Host 方法，参数为 `sessionId`、可选 `action`、`expectedTurn`；正在运行的会话返回 busy。

### retry 语义

`retry` 是带着现有历史重新提交用户输入的新轮次：不撤销工具副作用、不删除或覆盖已完成内容、不等同于逐字重放失败请求，会保留原输入的图片和文件引用。请求可能产生模型服务费用。

浏览器与 Host 断开不代表生成中止。插件仅根据会话日志与运行状态判断；连接恢复后由 Harness 同步状态。

## 实现

`index.js` 注册 `continueRecovery` 服务、`continue-availability` 投影、命令和工具；`core.js` 实现纯事件折叠及唯一恢复方法；`client.js` 通过 `conversation.input.activity` 插槽渲染按钮。

崩溃恢复复用 `sessionController.resolveAgent()`，由 Host 负责恢复、并发写入保护和模型配置。插件不定义新的会话事件，不轮询模型运行状态。

## 开发验证

```powershell
node scripts/check.mjs
node --test --test-isolation=none test/core.test.mjs
```

测试覆盖四种目标中断、正常完成、崩溃日志尾部、未提交输入恢复、图片引用、重复点击、并发恢复、错误返回、命令与工具的一致性。

## 许可证

[MIT](LICENSE)
