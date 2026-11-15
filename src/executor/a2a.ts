/**
 * A2A executor: works each Ticket as a conversation of an agent reached over the A2A 1.0 protocol, the one the main Session
 * chose when it accepted the Ticket, instead of a DSH worker Session in this process.
 *
 * The agents and how to reach each are in a JSON file the deployment writes (`DSH_SUPERAGENT_A2A_AGENTS_FILE`), read again
 * whenever it is needed. A Ticket's context id is its own id, so its Assignments and Inputs are one conversation of its
 * agent; each message's id is its Assignment's id, or the Assignment's and the Input's, so a delivery repeated after a
 * restart is the same A2A task. The tasks are kept in KV and followed until they end, also after a restart.
 *
 * What the agent did becomes the Ticket's Report when its task ends: a completed task is `ready`, its status message (the
 * agent's own account of what it did), the code it pushed and its reply the result the main Session delivers, and a pull
 * request its results name that this Ticket can claim is claimed; a rejected task is `dropped` with the agent's reason,
 * unless the agent handed back a follow-up, which goes back to Eval as a worker's hand-back does (`Engine.handback`); a
 * task that asks a person (`input-required`, `auth-required`) asks it as the Ticket's question; a failed one is `failed`.
 * The main Session hears each Report as it hears a worker's.
 *
 * Every request activates the host's task outcome extension (`TASK_OUTCOME_EXTENSION`), through which it says what core A2A
 * has no element for: that a rejected task was handed back, and the repository, branch, commit and pull request of the work.
 * A note of the main Session that names related tickets goes out with their latest tasks as `referenceTaskIds`.
 */
import { readFile } from 'node:fs/promises'
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions,
  type Client } from '@a2a-js/sdk/client'
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk'
import { UserError, latestAssignment, liveTicket, runningAssignment, type AssessmentOutcome, type Assignment, type ConversationLink,
  type EngineForExecutor, type Execution, type Executor, type Ticket, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import type { Sessions } from '../app/sessions.ts'
import { reportRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { TranscriptEntry } from '../app/context.ts'
import { claimPull, readPull } from '../sources/github-pull.ts'
import type { SourceContext } from '../sources/host.ts'
import { batchLine, batchOf, inputMessage, mandateInstructions, sourceTrigger, ticketExecution, triggerMessage } from './dsh.ts'

/** One agent the deployment offers, with the A2A endpoint and bearer that reach it. */
export interface A2AAgent { agent_id: string; name: string; description: string; url: string; token: string }
/** One A2A task of a Ticket: the message that started it, and whether its end was recorded. */
interface TicketTask { id: string; assignment: string; input?: string; settled?: true; stopped?: true }
/** A Ticket's conversation: its agent, the page that shows the conversation, and its tasks, oldest first. */
interface TicketConversation { agent: string; conversation?: string; tasks: TicketTask[] }
/** Each Ticket's conversation, by ticket id. */
const CONVERSATIONS = family<TicketConversation>('a2a-ticket:')

export interface A2AExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted' | 'handback'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'afterCommit' | 'get' | 'set'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry: whether the agents can be reached. */
  readonly health: HealthEntry
  readonly machine: { stateDir: string }
  readonly lifetime: AbortSignal
  readonly sessions: Pick<Sessions, 'relay'>
  /** The JSON file that lists the agents (`A2AAgent[]`). */
  readonly agentsFile: string
  /** The GitHub Source, when this installation has a GitHub account, whose rules govern claiming a pull request. */
  github(): SourceContext | undefined
  closing(): boolean
  paused(): boolean
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** The team's Ticket scope and Delivery requirements sections, as the worker prompt has them. */
  instructions(): string
}

/**
 * The A2A extension of AstraBox, the agents' host, for what core A2A has no element for (AstraBox's docs/a2a.md, "Task outcome
 * extension"): `handback` on a rejected task's status message, and the work's code references on its result artifact.
 */
export const TASK_OUTCOME_EXTENSION = 'https://www.astrabox.ai/docs/a2a#task-outcome-v1'
/** The request options that activate the task outcome extension, as the SDK sends them (the `A2A-Extensions` header). */
const activated = () => ({ serviceParameters: ServiceParameters.create(withA2AExtensions(TASK_OUTCOME_EXTENSION)) })
/** The extension's data on a message or artifact that names it, else undefined. */
const extensionData = (object: { extensions: string[]; metadata: { [key: string]: unknown } | undefined } | undefined) =>
  object?.extensions.includes(TASK_OUTCOME_EXTENSION) ? object.metadata?.[TASK_OUTCOME_EXTENSION] as Record<string, unknown> | undefined : undefined
const terminal = (state: TaskState) => state === TaskState.TASK_STATE_COMPLETED || state === TaskState.TASK_STATE_FAILED
  || state === TaskState.TASK_STATE_CANCELED || state === TaskState.TASK_STATE_REJECTED
const asking = (state: TaskState) => state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED
/** The text of a task's status message and result, for a Report. */
function taskText(task: Task): string {
  const parts = [...task.status?.message?.parts ?? [], ...task.artifacts.flatMap(artifact => artifact.parts)]
  return parts.flatMap(part => part.content?.$case === 'text' ? [part.content.value] : []).join('\n\n').trim()
}
const texts = (parts: Task['artifacts'][number]['parts']) => parts.flatMap(part => part.content?.$case === 'text' ? [part.content.value] : [])
/** The text of a task's status message: in a task that ended, why it ended as it did, in the agent's words. */
const statusText = (task: Task): string => texts(task.status?.message?.parts ?? []).join('\n\n').trim()
/** Whether the agent handed a rejected task back for routing elsewhere. */
const handedBack = (task: Task): boolean => extensionData(task.status?.message)?.handback === true
/** The code the agent's work left, as its result artifact names it. */
function pushed(task: Task): string {
  const named = task.artifacts.map(extensionData).find(Boolean) ?? {}
  const fields = ['repository', 'branch', 'commit', 'pull_request'].flatMap(name => typeof named[name] === 'string' ? [`${name} ${named[name]}`] : [])
  return fields.length ? `Pushed: ${fields.join(', ')}` : ''
}
/** A finished task as the Ticket's Report summary: the agent's account first, then the code, then its reply. */
const resultSummary = (task: Task): string => [statusText(task), pushed(task), ...task.artifacts.flatMap(artifact => texts(artifact.parts))]
  .filter(Boolean).join('\n\n').trim()
/** Everything a task carries, as text, where a pull request it opened is named. */
const taskEvidence = (task: Task): string => JSON.stringify([task.status?.message, task.artifacts])
const message = (contextId: string, messageId: string, text: string, referenceTaskIds: string[]): Message => ({ messageId, contextId,
  taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata: undefined, extensions: [], referenceTaskIds })

/** The first message of a Ticket's conversation: what is asked, by whom and where, and how the work is delivered. */
export function assignmentMessage(ticket: Ticket, request: object | undefined, batch: object[], environment: Variable[],
  instructions: string, prepare: string): string {
  const value = (key: string) => environment.find(variable => variable.key === key)?.value ?? ''
  const repository = value('DSH_SUPERAGENT_GITHUB_REPOSITORY'), name = ticket.execution?.name ?? ''
  // The installation's prepare command runs in the agent's workspace, where this ticket's directory is a new one of its own.
  const variables = environment.filter(variable => variable.key !== 'DSH_SUPERAGENT_DIR' && variable.value)
    .map(variable => `${variable.key}=${JSON.stringify(variable.value)}`)
  const prepared = prepare.trim() ? [
    `First prepare this request's directory as this installation does: in your workspace, run the command below with sh, with `
      + `DSH_SUPERAGENT_DIR set to a new directory named ${name} in your workspace and these variables set: ${variables.join(' ')}. `
      + 'Then work in that directory.',
    '```sh\n' + prepare.trim() + '\n```',
  ] : []
  const github = repository ? [
    `The work is in the GitHub repository ${repository}. ${prepare.trim() ? 'Make' : 'Clone it into your workspace and make'} the change `
      + `on a branch whose last path segment is exactly \`${name}\`, such as \`agent/${name}\`. This request may have been worked `
      + 'before, in a workspace you do not have: unless your workspace already has its branch, look for one on the remote first '
      + `(\`git ls-remote --heads origin ${name}\`) and continue from it; start a new branch only when there is none.`,
    `Commit as ${value('DSH_SUPERAGENT_GITHUB_ACCOUNT')} <${value('DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL')}>, and push the branch after each `
      + 'meaningful step, not only at the end, so the work outlives your workspace. Open a pull request from it with the GitHub CLI; that '
      + 'pull request is how this request is followed; name its URL in your reply.',
  ] : []
  return [
    `You are working one request that dsh-superagent took on: ${ticket.title}.`,
    ...ticket.execution?.assignment ? [ticket.execution.assignment] : [],
    ...mandateInstructions(ticket.mandate) ? [mandateInstructions(ticket.mandate)] : [],
    'The request, as its source recorded it:', JSON.stringify(request ?? {}),
    ...batch.length ? ['Other messages that came with it:', ...batch.map(line => JSON.stringify(line))] : [],
    ...prepared,
    ...github,
    'Reply, when you are done, with what you did. If you need a person to decide or tell you something, ask in your reply and stop: '
      + 'their answer arrives as your next message. Later messages here are follow-ups on the same request, such as replies on its '
      + 'thread or CI results.',
    'Before your final reply to this message and to each later one, report its outcome with your report_outcome tool: '
      + 'TASK_STATE_COMPLETED with what you did, or TASK_STATE_REJECTED with why you will not do it, with handback when it is for '
      + 'another agent or must be split, saying what should happen instead.'
      + (repository ? ' Name the repository, the branch and the last commit you pushed, and the pull request.' : ''),
    ...instructions ? [instructions] : [],
  ].join('\n\n')
}

/**
 * Executes Tickets as A2A conversations. Launches and deliveries run as the `launch` and `delivery` effects, held while
 * processing is paused; `maxWorkers` bounds the Tickets whose agent works at once.
 */
export class A2AExecutor implements Executor {
  readonly kind = 'a2a' as const
  private agents: A2AAgent[] = []
  private readonly clients = new Map<string, Promise<Client>>()
  /** The tasks being followed, by task id. */
  private readonly following = new Map<string, AbortController>()
  constructor(private readonly host: A2AExecutorHost) {
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : 4, retry: [5000, 300_000] })
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** The agents the deployment offers now; the main Session reads them to choose one. */
  async list(): Promise<A2AAgent[]> {
    this.agents = JSON.parse(await readFile(this.host.agentsFile, 'utf8')) as A2AAgent[]
    return this.agents
  }
  /** A newly accepted Ticket's execution: its name, as a worker's, and the agent the main Session chose. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const agent = outcome.agent?.trim()
    if (!agent) throw new UserError('agentRequired', { agents: this.agents.map(item => `${item.agent_id} (${item.name})`).join(', ') })
    if (!this.agents.some(item => item.agent_id === agent)) throw new UserError('unknownAgent', { agent })
    const execution: Execution = { ...ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir), agent }
    return { ...ticket, execution }
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** Cancels the Ticket's tasks that have not ended; their ends are not reported, as the domain already ended the work. */
  stop(ticket: Ticket, _assignment: Assignment, _reason: string): void {
    this.host.store.afterCommit(() => { void this.cancelOpen(ticket.id) })
  }
  install(): void { void this.list().catch(error => { this.unreachable(error) }) }
  /** Follows every task of an open Ticket that has not ended, and launches what waits. */
  resume(): void {
    for (const ticket of this.host.store.tickets.open()) {
      const running = runningAssignment(ticket)
      const open = (this.host.store.get(CONVERSATIONS(ticket.id))?.tasks ?? []).filter(task => !task.settled)
      for (const task of open) this.follow(ticket.id, task)
      if (running && !open.length && !this.host.store.get(CONVERSATIONS(ticket.id))) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      const pending = latestAssignment(ticket)
      if (pending?.state === 'pending') this.start(ticket, pending)
    }
  }
  /** Tickets whose agent is working: a task of theirs has not ended. */
  activeCount(): number {
    return this.host.store.tickets.open().filter(ticket => (this.host.store.get(CONVERSATIONS(ticket.id))?.tasks ?? [])
      .some(task => !task.settled)).length
  }
  /** The page the agent named for the Ticket's conversation, once a task of it started. */
  conversation(ticket: Ticket): ConversationLink | undefined {
    const page = this.host.store.get(CONVERSATIONS(ticket.id))?.conversation
    return page ? { page } : undefined
  }
  /** The Ticket's conversation as the agent keeps it: each task's history, oldest first. */
  async transcript(ticketId: string, signal?: AbortSignal): Promise<TranscriptEntry[]> {
    const conversation = this.host.store.get(CONVERSATIONS(ticketId))
    if (!conversation) return []
    const client = await this.client(await this.agent(conversation.agent))
    const entries: TranscriptEntry[] = []
    for (const { id } of conversation.tasks) {
      for (const item of (await client.getTask({ tenant: '', id }, { signal })).history) {
        const role = item.role === Role.ROLE_AGENT ? 'assistant' : 'user'
        entries.push({ type: `${role}/message`, message: { role, content: item.parts.map(part => part.content?.$case === 'text'
          ? { type: 'text', text: part.content.value }
          : { type: part.content?.$case ?? 'part', ...part.content?.$case === 'data' ? { data: part.content.value } : {} }) } })
      }
    }
    return entries
  }
  async shutdown(): Promise<void> { for (const controller of this.following.values()) controller.abort() }
  dispose(): void { this.following.clear(); this.clients.clear() }

  private unreachable(error: unknown): void {
    this.host.health.set({ state: 'error', detail: `The agents cannot be reached: ${error instanceof Error ? error.message : String(error)}`,
      at: new Date().toISOString() })
  }
  private async agent(id: string): Promise<A2AAgent> {
    const agent = (await this.list()).find(item => item.agent_id === id)
    if (!agent) throw new Error(`The agent ${id} is no longer offered`)
    return agent
  }
  /** One A2A client per agent endpoint and bearer, through the agent card the endpoint serves. */
  private client(agent: A2AAgent): Promise<Client> {
    const cacheKey = `${agent.url}\n${agent.token}`
    let client = this.clients.get(cacheKey)
    if (!client) {
      const fetchImpl: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('Authorization', `Bearer ${agent.token}`)
        headers.set('A2A-Version', '1.0')
        return fetch(input, { ...init, headers })
      }
      const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }))
      // The card is served below the agent's own path; a path argument starting with `/` would replace that path.
      client = factory.createFromUrl(`${agent.url.replace(/\/+$/, '')}/.well-known/agent-card.json`, '')
      client.catch(() => { this.clients.delete(cacheKey) })
      this.clients.set(cacheKey, client)
    }
    return client
  }
  private record(ticketId: string, agent: string, task: TicketTask, conversation?: string): void {
    const current = this.host.store.get(CONVERSATIONS(ticketId)) ?? { agent, tasks: [] }
    const tasks = current.tasks.some(item => item.id === task.id) ? current.tasks : [...current.tasks, task]
    this.host.store.set(CONVERSATIONS(ticketId), { ...current, ...conversation ? { conversation } : {}, tasks })
  }
  private settle(ticketId: string, taskId: string): void {
    const current = this.host.store.get(CONVERSATIONS(ticketId))
    if (current) this.host.store.set(CONVERSATIONS(ticketId), { ...current, tasks: current.tasks.map(task => task.id === taskId ? { ...task, settled: true } : task) })
  }
  /** Sends one message of a Ticket's conversation, which refers to the tasks `references`, and returns its task. */
  private async send(ticket: Ticket, messageId: string, text: string, references: string[] = []): Promise<Task> {
    const agent = await this.agent(ticket.execution?.agent ?? '')
    const result = await (await this.client(agent)).sendMessage({ tenant: '', message: message(ticket.id, messageId, text, references),
      configuration: { acceptedOutputModes: [], taskPushNotificationConfig: undefined, historyLength: 0, returnImmediately: true },
      metadata: undefined }, { signal: this.host.lifetime, ...activated() })
    if (!('status' in result)) throw new Error('The agent answered with a message instead of a task')
    this.host.health.set({ state: 'ready', detail: 'The agents answer', at: new Date().toISOString() })
    return result
  }
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    if (this.activeCount() >= this.host.store.settings().executor.maxWorkers) throw new Later('Every worker slot is taken')
    try {
      const source = sourceTrigger(this.host, ticket)
      const request = source ? triggerMessage(source, await this.host.sourceLink(source, this.host.lifetime)) : undefined
      const text = assignmentMessage(ticket, request, batchOf(this.host, ticket).map(batchLine), this.host.environment(ticket),
        this.host.instructions(), this.host.store.settings().executor.prepare)
      const task = await this.send(ticket, assignment.id, text)
      this.host.store.atomic(() => {
        this.record(ticket.id, ticket.execution?.agent ?? '', { id: task.id, assignment: assignment.id }, conversationOf(task))
        this.host.engine.assignmentStarted(ticket.id, assignment.id)
      })
      this.follow(ticket.id, { id: task.id, assignment: assignment.id })
    } catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      this.unreachable(error)
      throw error
    }
  }
  private async deliverQueued(ticketId: string): Promise<void> {
    for (;;) {
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
      const inputId = ticket?.undelivered[0]
      if (!ticket || !assignment || inputId === undefined) return
      const input = ticket.inputs.find(item => item.id === inputId)
      try {
        const trigger = input?.kind === 'trigger' ? this.host.store.triggers.get(input.triggerId) : undefined
        const card = trigger ? triggerMessage(trigger, await this.host.sourceLink(trigger, this.host.lifetime), input?.kind === 'trigger' ? input.note : undefined) : undefined
        const text = input ? inputMessage(input, card) : undefined
        // A note from related tickets refers to the task each of them sent last.
        const references = input?.kind === 'note'
          ? (input.tickets ?? []).flatMap(id => this.host.store.get(CONVERSATIONS(id))?.tasks.at(-1)?.id ?? []) : []
        if (text !== undefined) {
          const task = await this.send(ticket, `${assignment.id}:${inputId}`, text, references)
          this.host.store.atomic(() => {
            this.record(ticket.id, ticket.execution?.agent ?? '', { id: task.id, assignment: assignment.id, input: inputId })
            this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
          })
          this.follow(ticket.id, { id: task.id, assignment: assignment.id, input: inputId })
        } else this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      } catch (error) {
        if (this.host.closing() || error instanceof Later) throw error
        const current = this.host.store.tickets.get(ticketId)
        if (current && liveTicket(current) && runningAssignment(current)?.id === assignment.id) {
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
        }
        throw error
      }
    }
  }
  /** Follows one task until it ends, through the agent's task subscription, and records what it did. */
  private follow(ticketId: string, task: TicketTask): void {
    if (this.following.has(task.id)) return
    const controller = new AbortController()
    this.following.set(task.id, controller)
    const signal = AbortSignal.any([controller.signal, this.host.lifetime])
    void (async () => {
      let delay = 1000
      while (!signal.aborted) {
        try {
          const ticket = this.host.store.tickets.get(ticketId)
          if (!ticket) return
          const client = await this.client(await this.agent(ticket.execution?.agent ?? ''))
          let current = await client.getTask({ tenant: '', id: task.id, historyLength: 0 }, { signal, ...activated() })
          if (!terminal(current.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) {
            this.observe(ticketId, task, current)
            for await (const event of client.resubscribeTask({ tenant: '', id: task.id }, { signal, ...activated() })) {
              const payload = event.payload
              if (payload?.$case === 'task') current = payload.value
              else if (payload?.$case === 'statusUpdate') current = { ...current, status: payload.value.status }
              else if (payload?.$case === 'artifactUpdate') {
                const artifact = payload.value.artifact
                current = artifact ? { ...current, artifacts: [...current.artifacts.filter(item => item.artifactId !== artifact.artifactId), artifact] } : current
              }
              this.observe(ticketId, task, current)
              if (terminal(current.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) break
            }
            current = await client.getTask({ tenant: '', id: task.id, historyLength: 0 }, { signal, ...activated() })
          }
          if (terminal(current.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) { await this.ended(ticketId, task, current); return }
        } catch (error) {
          if (signal.aborted) return
          this.unreachable(error)
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 60_000)
      }
    })().finally(() => { this.following.delete(task.id) })
  }
  /** A task that has not ended: its message was taken, or it asks a person. */
  private observe(ticketId: string, task: TicketTask, current: Task): void {
    const state = current.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    this.host.store.atomic(() => {
      if (task.input && state !== TaskState.TASK_STATE_SUBMITTED) this.host.engine.inputsRead(ticketId, [task.input])
      if (asking(state) && !ticket.attention) {
        const conversation = this.host.store.get(CONVERSATIONS(ticketId))?.conversation
        const question = [taskText(current) || 'The agent waits for a person.',
          ...conversation ? [`Answer it in the agent's conversation: ${conversation}`] : []].join('\n')
        this.report(ticketId, { state: 'blocked', summary: 'The agent asks a person', question })
      } else if (state === TaskState.TASK_STATE_WORKING && ticket.attention) {
        this.report(ticketId, { state: 'progress', summary: 'The agent works again', question: null })
      }
    })
  }
  /** A task that ended: the Ticket's Report, unless the work was stopped or the Ticket ended. */
  private async ended(ticketId: string, task: TicketTask, current: Task): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const record = this.host.store.get(CONVERSATIONS(ticketId))?.tasks.find(item => item.id === task.id)
    const state = current.status?.state
    const summary = resultSummary(current) || 'The agent ended without a reply.'
    const github = this.host.github()
    const repository = github?.deployment.repository
    const numbers = repository && state === TaskState.TASK_STATE_COMPLETED
      ? [...new Set([...taskEvidence(current).matchAll(new RegExp(`github\\.com/${repository.replace('.', '\\.')}/pull/(\\d+)`, 'g'))].map(match => Number(match[1])))]
      : []
    const pulls = github ? await Promise.all(numbers.map(number => readPull(github, number, this.host.lifetime).catch(() => undefined))) : []
    this.host.store.atomic(() => {
      this.settle(ticketId, task.id)
      if (!ticket || !liveTicket(ticket) || record?.stopped) return
      if (github) for (const pull of pulls) if (pull) claimPull(github, ticketId, pull)
      if (state === TaskState.TASK_STATE_COMPLETED) {
        this.report(ticketId, { state: 'ready', summary })
        this.host.engine.turnEnded(ticketId, task.assignment)
      } else if (state === TaskState.TASK_STATE_FAILED) this.report(ticketId, { state: 'failed', summary })
      else if (state === TaskState.TASK_STATE_REJECTED) {
        const reason = statusText(current) || 'The agent gave no reason.'
        const input = task.input ? ticket.inputs.find(item => item.id === task.input) : undefined
        if (handedBack(current) && input?.kind === 'trigger') {
          // A follow-up the agent will not take is handed back as a worker hands one back: to a fresh assessment, with the
          // agent's reason, while the ticket keeps its work.
          this.host.engine.handback(ticketId, input.triggerId, reason)
          this.host.engine.turnEnded(ticketId, task.assignment)
        } else {
          // The ticket's own request: a Trigger that started a ticket starts no other (Evals.decide), so it ends here.
          const why = handedBack(current) ? 'The agent handed this request back for another agent or for splitting' : 'The agent declined this request'
          this.report(ticketId, { state: 'dropped', summary: `${why}. ${reason}` })
        }
      } else this.report(ticketId, { state: 'blocked', summary: `The agent's work was stopped outside this ticket. ${summary}` })
    })
  }
  private report(ticketId: string, report: { state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string;
    question?: string | null }): void {
    const updated = this.host.engine.report(ticketId, report)
    const relay = reportRelay(updated, report)
    if (relay) this.host.sessions.relay(relay.id, relay.text)
  }
  private async cancelOpen(ticketId: string): Promise<void> {
    const conversation = this.host.store.get(CONVERSATIONS(ticketId))
    if (!conversation) return
    this.host.store.atomic(() => {
      this.host.store.set(CONVERSATIONS(ticketId), { ...conversation,
        tasks: conversation.tasks.map(task => task.settled ? task : { ...task, stopped: true }) })
    })
    const agent = await this.agent(conversation.agent).catch(() => undefined)
    if (!agent) return
    const client = await this.client(agent)
    for (const task of conversation.tasks.filter(item => !item.settled)) {
      await client.cancelTask({ tenant: '', id: task.id, metadata: undefined }).catch(() => { /* Ended already, or the agent keeps it. */ })
    }
  }
}
/** The page that shows the agent's conversation, when the agent names one. */
function conversationOf(task: Task): string | undefined {
  const path = task.metadata?.session_url_path
  return typeof path === 'string' && path ? path : undefined
}
