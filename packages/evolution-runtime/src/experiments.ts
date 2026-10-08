import type { Agent } from "@deepseek-ai/dsh-agent";

export interface ExperimentCoordinator {
  tasks(agent: Agent): Promise<string>;
  start(agent: Agent, maxRequests: number, command: string): Promise<string>;
  audit(agent: Agent, sourceId: string, maxRequests: number, taskFile: string, command: string): Promise<string>;
  assess(agent: Agent, sourceId: string, maxRequests: number, command: string, taskFile?: string): Promise<string>;
  recheck(agent: Agent, sourceId: string, maxRequests: number, taskFile: string, command: string): Promise<string>;
  probe(agent: Agent, sourceId: string, maxRequests: number, taskFile: string, command: string): Promise<string>;
  resume(agent: Agent, id: string): Promise<string>;
  stop(agent: Agent): Promise<string>;
  status(agent: Agent): Promise<string>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { chopinExperiments: ExperimentCoordinator }
}
