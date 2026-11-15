/**
 * The Source plugin interface for a separate package (docs/008-cookbook.md): a dsh plugin that implements a `SourceKind`
 * and registers it with the `orchestrator` service. It imports from `dsh-superagent/sources`, the same installed package
 * the bundle runs, so `CliError` and the Source host are the bundle's own.
 */
export type * from './kind.ts'
export type { Health, HealthCode, SourceContext, SourceHost, ThreadDescription } from './host.ts'
export { HEALTH_TEXT, health, sourceContext } from './host.ts'
export { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
export { KV, family, record, type Family, type Key } from '../kv.ts'
export { POLL_HORIZON_MS, cursorAt, pause, pollThreads, polled } from './poll.ts'
export * from '../core/index.ts'
