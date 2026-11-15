# superagent-a2a

[English](README.md) | 简体中文

superagent-a2a 是一个面向团队的主动式编码 agent，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle 形式打包。它在团队原本提需求的地方接活：GitHub 仓库、可选的飞书，或者你们自己的工单服务。有权限的人提出需求后，它会开一张 Ticket，交给一个 agent 去做，然后在原来的对话里答复，例如给出一个 pull request。Web 面板上只显示需要人处理的事项。

它基于 DeepSeek Harness 团队的研究原型 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)，并沿用它的工作方式：**尽量少占用人的注意力，尽量多交付价值。** agent 只在有人提出请求、或团队写下的规则允许时才行动，只在需要人处理或有结果可用时才发言。[docs/000-philosophy.md](docs/000-philosophy.md) 说明了这条原则以及它对运维者的要求。

和它所基于的原型一样，这是研究性质的代码，不是可直接用于生产的软件。在自己的环境中使用前，请先审阅并按需调整。

## 这个仓库新增了什么

- **通过 A2A 使用 agent。** dsh-superagent 把每张 Ticket 放在自身进程的 worker Session 里完成。在这里，部署方可以改为列出一组支持 [A2A 1.0](https://a2a-protocol.org/) 的 agent，每张 Ticket 就成为主 Session 为它选定的那个 agent 的一段对话。superagent 负责判断、分派和答复，agent 在各自运行的地方干活。
- **拿到的是结果，不只是回复。** 任务完成后成为一份就绪的 Report，包含 agent 对所做工作的说明、它推送的代码和它的回复。agent 可以带理由拒绝一个请求，也可以把后续跟进退回给 superagent 重新分派。需要人参与的任务会作为 Ticket 的问题提给人。
- **GitHub 是可选的。** GitHub Source 既不指定仓库也不指定 agent CLI 时，这个安装就不使用 GitHub，其他 Source 照常运行。
- **Source 可以放在独立的包里。** Source 接口以 `dsh-superagent/sources` 导出，所以对接你们自己的工单或待办服务的 Source 可以做成一个 dsh 插件，装在 bundle 旁边。见 [008 Cookbook](docs/008-cookbook.md)。

包名和命令仍然叫 `dsh-superagent`。

## 安装

安装步骤很多，所以由一个 agent 陪你完成。对你的编码 agent 说：

> Read SETUP.md in this repository and set up dsh-superagent with me.

它每次只问一个简短的问题，把完整方案展示一次，然后安装并配置好一切。它遵循的是 [SETUP.md](SETUP.md)。

## 通过 A2A 让 agent 干活

把 `DSH_SUPERAGENT_A2A_AGENTS_FILE` 设为一个列出 agent 的 JSON 文件。每次用到时都会重新读取这个文件，所以 superagent 运行期间可以修改列表：

```json
[
  {
    "agent_id": "backend",
    "name": "Backend engineer",
    "description": "Works on the API service and its tests.",
    "url": "https://agents.example.com/a2a/backend",
    "token": "<这个 agent 的 bearer token>"
  }
]
```

主 Session 能看到每个 agent 的名称和描述，在接受一张 Ticket 时选定其中一个。此后：

- Ticket 的 id 就是 A2A 的 context id，所以它的各次指派和人的后续跟进都属于该 agent 的同一段对话。消息 id 由指派推导而来，所以重启后重复投递的仍是同一个任务。
- 任务会被一直跟踪到结束，重启后也一样。`completed` 成为就绪的 Report，`rejected` 以 agent 给出的理由关闭 Ticket，`input-required` 和 `auth-required` 成为 Ticket 的问题，`failed` 使 Ticket 失败。
- agent 自己不在 Source 里发任何内容。superagent 根据 agent 的报告和回复来答复提问的人。
- 提到相关 Ticket 的备注会带上它们最近的任务，作为 `referenceTaskIds` 发出。

有两件 superagent 需要的事，核心 A2A 里没有对应的元素：一个被拒绝的任务是被退回而不是被谢绝；以及工作成果所在的仓库、分支、提交和 pull request。因此每个请求都会激活一个 A2A 扩展 `https://www.astrabox.ai/docs/a2a#task-outcome-v1`，在 agent 的宿主支持时从任务的 metadata 里读取这些信息。宿主不支持这个扩展的 agent，仍然可以只靠核心 A2A 协作。

不设置这个变量时，Ticket 和 dsh-superagent 一样在 worker Session 里运行。

## 文档

请按编号顺序阅读，每一篇只依赖它之前的内容（文档为英文）。

- [000 Philosophy](docs/000-philosophy.md)：理念
- [001 Domain model](docs/001-domain.md)：领域模型
- [002 Authorization](docs/002-authorization.md)：授权
- [003 Execution](docs/003-execution.md)：执行
- [004 Prompts](docs/004-prompts.md)：提示词
- [005 Panel](docs/005-panel.md)：面板
- [006 Deployment](docs/006-deployment.md)：手动安装、配置、升级与排障
- [007 Architecture](docs/007-architecture.md)：架构
- [008 Cookbook](docs/008-cookbook.md)：添加一个 Source

## 开发

`pnpm check` 会运行类型检查、测试和构建。

## 配合 AstraBox 使用

[AstraBox](https://github.com/Colton-z/AstraBox) 是一个自托管的 agent 运行时，在沙箱里运行 Claude Code、Codex 等编码 agent，并把每个 agent 通过 A2A 暴露出来。它可以把这个 bundle 作为 Assistant 运行：AstraBox 在沙箱里启动 superagent，根据所有者的 Agent 生成 agents 文件，并在控制台里展示面板。之后每张 Ticket 都在其中某个 Agent 的沙箱对话里完成，Agent 可以通过上面的扩展报告结果。详见 AstraBox 文档中的 [Assistants that work from a panel](https://github.com/Colton-z/AstraBox/blob/main/docs/assistants.md#panel-runtimes)。

## 许可证

[MIT](LICENSE)
