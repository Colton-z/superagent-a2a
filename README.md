# superagent-a2a

superagent-a2a is a proactive coding agent for a team, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to where the team already asks for work: a GitHub repository, optionally Feishu, or a ticket service of your own. When someone allowed asks for work, it opens a Ticket, has an agent work on it, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is based on [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype), the DeepSeek Harness team's research prototype, and keeps its way of working: **take as little human attention as possible, and give as much value as possible.** The agent acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

Like the prototype it builds on, this is research code rather than production-ready software. Review and adapt it before using it in your own environment.

## What this repository adds

- **Agents over A2A.** dsh-superagent works every Ticket in a worker Session of its own process. Here a deployment can instead list agents that speak [A2A 1.0](https://a2a-protocol.org/), and each Ticket becomes a conversation with the agent the main Session chose for it. The superagent decides, routes and answers people; the agents do the work wherever they run.
- **Outcomes, not just replies.** A completed task becomes a ready Report with the agent's own account of what it did, the code it pushed and its reply. An agent can decline a request with a reason, or hand a follow-up back for the superagent to route again. A task that needs a person asks it as the Ticket's question.
- **GitHub is optional.** A GitHub Source that names neither a repository nor an agent CLI leaves the installation without GitHub, and its other Sources run.
- **Sources in their own package.** The Source interface is exported as `dsh-superagent/sources`, so a Source for your own ticket or to-do service can be a dsh plugin installed beside the bundle. See [008 Cookbook](docs/008-cookbook.md).

The package and its commands keep the name `dsh-superagent`.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Working through agents over A2A

Set `DSH_SUPERAGENT_A2A_AGENTS_FILE` to a JSON file that lists the agents. The file is read again whenever it is needed, so the list can change while the superagent runs:

```json
[
  {
    "agent_id": "backend",
    "name": "Backend engineer",
    "description": "Works on the API service and its tests.",
    "url": "https://agents.example.com/a2a/backend",
    "token": "<bearer token for this agent>"
  }
]
```

The main Session sees each agent's name and description and chooses one when it accepts a Ticket. From then on:

- The Ticket's id is the A2A context id, so its assignments and a person's follow-ups are one conversation of that agent. Message ids are derived from the assignment, so a delivery repeated after a restart is the same task.
- Tasks are followed until they end, also across a restart. `completed` is a ready Report, `rejected` drops the Ticket with the agent's reason, `input-required` and `auth-required` become the Ticket's question, and `failed` fails it.
- Agents post nothing in the Source themselves. The superagent answers the person from the agent's report and reply.
- A note that names related Tickets goes out with their latest tasks as `referenceTaskIds`.

Core A2A has no element for two things the superagent needs: that a rejected task was handed back rather than declined, and the repository, branch, commit and pull request of the work. Every request therefore activates one A2A extension, `https://www.astrabox.ai/docs/a2a#task-outcome-v1`, and reads those from the task's metadata when the agent's host supports it. An agent whose host does not is still worked with through core A2A alone.

Without the variable, Tickets run in worker Sessions as in dsh-superagent.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## Using it with AstraBox

[AstraBox](https://github.com/Colton-z/AstraBox) is a self-hosted agent runtime that runs Claude Code, Codex and other coding agents in sandboxes and exposes each one over A2A. It can run this bundle as an Assistant: AstraBox starts the superagent in a sandbox, writes the agents file from the owner's Agents, and shows the panel in its console. Each Ticket is then worked in a sandboxed conversation of one of those Agents, which can report its outcome through the extension above. See [Assistants that work from a panel](https://github.com/Colton-z/AstraBox/blob/feat/0.1.15-integration/docs/assistants.md#panel-runtimes) in the AstraBox documentation.

## License

[MIT](LICENSE)
