/** The deployment's GitHub account, for code that runs only when the GitHub Source has one. */
import type { Deployment } from './deployment.ts'

export interface GithubAccount { cli: string; login: string; noreply: string; repository: string }
/** True when setup resolved a GitHub account and repository. */
export const hasGithub = (deployment: Pick<Deployment, 'github' | 'repository'>): boolean => !!deployment.github && !!deployment.repository
/** The GitHub account and repository; throws for an installation whose GitHub Source names neither. */
export function githubOf(deployment: Pick<Deployment, 'github' | 'repository'>): GithubAccount {
  const { github, repository } = deployment
  if (!github || !repository) throw new Error('This installation has no GitHub account: set the repository and the agent CLI on the GitHub Source')
  return { ...github, repository }
}
