import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { carried, type Launch, type Workspace, type WorkspaceProvider, type WorkspaceState } from "./workspace.js";

/** Runs the container CLI with `args` and resolves with its standard output. */
export type ContainerCli = (args: readonly string[]) => Promise<string>;

export interface ContainerWorkspaceOptions {
  /** Image every workspace boots from; it must keep running on its own. */
  image: string;
  /** Names containers and volumes; providers with different prefixes never see each other's workspaces. */
  prefix?: string;
  /** Where the volume is mounted, also the working directory. */
  mountPath?: string;
  limits?: { cpus?: number; memory?: string; pids?: number };
  binary?: string;
  cli?: ContainerCli;
}

type Resolved = ContainerWorkspaceOptions & Required<Pick<ContainerWorkspaceOptions, "prefix" | "mountPath" | "binary" | "cli">>;

/** Runs `work` after every earlier operation on the same container has ended. */
type Serial = <T>(name: string, work: () => Promise<T>) => Promise<T>;

const OWNER_LABEL = "chopin.owner";
const PROVIDER_LABEL = "chopin.provider";
const execFileAsync = promisify(execFile);

export function containerCli(binary: string): ContainerCli {
  return async (args) => (await execFileAsync(binary, args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** One container and one named volume per owner on the local container engine. */
export class ContainerWorkspaceProvider implements WorkspaceProvider {
  readonly #options: Resolved;
  readonly #queues = new Map<string, Promise<unknown>>();
  // Lifecycle steps check and then act; two at once on one container would both create it.
  readonly #serial: Serial = (name, work) => {
    const run = (this.#queues.get(name) ?? Promise.resolve()).then(work, work);
    const tail = run.then(() => {}, () => {}).finally(() => {
      if (this.#queues.get(name) === tail) this.#queues.delete(name);
    });
    this.#queues.set(name, tail);
    return run;
  };

  constructor(options: ContainerWorkspaceOptions) {
    const binary = options.binary ?? "docker";
    this.#options = {
      ...options,
      prefix: options.prefix ?? "chopin",
      mountPath: options.mountPath ?? "/workspace",
      binary,
      cli: options.cli ?? containerCli(binary),
    };
  }

  open(owner: string): Workspace {
    if (owner === "" || /[\r\n]/.test(owner)) throw new Error("a workspace owner is a non-empty single line");
    return new ContainerWorkspace(owner, this.#options, this.#serial);
  }

  async list(): Promise<Workspace[]> {
    const out = await this.#options.cli([
      "ps", "--all", "--filter", `label=${PROVIDER_LABEL}=${this.#options.prefix}`,
      "--format", `{{.Label "${OWNER_LABEL}"}}`,
    ]);
    // Owners exactly as labelled, spaces included.
    return out.split("\n").filter((owner) => owner !== "").map((owner) => this.open(owner));
  }
}

class ContainerWorkspace implements Workspace {
  readonly owner: string;
  readonly root: string;
  readonly #name: string;
  readonly #options: Resolved;
  readonly #serial: Serial;

  constructor(owner: string, options: Resolved, serial: Serial) {
    this.owner = owner;
    this.root = options.mountPath;
    this.#options = options;
    this.#serial = serial;
    this.#name = `${options.prefix}-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}`;
  }

  async state(): Promise<WorkspaceState> {
    const out = await this.#options.cli(["ps", "--all", "--filter", `name=^${this.#name}$`, "--format", "{{.State}}"]);
    const [state] = lines(out);
    if (state === undefined) return "absent";
    if (state === "running" || state === "paused") return state;
    return "stopped";
  }

  start(): Promise<void> {
    return this.#serial(this.#name, () => this.#start());
  }

  async #start(): Promise<void> {
    const state = await this.state();
    if (state === "running") return;
    if (state === "paused") {
      await this.#cli("unpause", this.#name);
      return;
    }
    if (state === "absent") await this.#create();
    await this.#cli("start", this.#name);
  }

  pause(): Promise<void> {
    return this.#serial(this.#name, () => this.#pause());
  }

  async #pause(): Promise<void> {
    if (await this.state() === "running") await this.#cli("pause", this.#name);
  }

  stop(): Promise<void> {
    return this.#serial(this.#name, () => this.#stop());
  }

  async #stop(): Promise<void> {
    const state = await this.state();
    if (state === "paused") await this.#cli("unpause", this.#name);
    if (state === "paused" || state === "running") await this.#cli("stop", this.#name);
  }

  destroy(): Promise<void> {
    return this.#serial(this.#name, () => this.#destroy());
  }

  async #destroy(): Promise<void> {
    if (await this.state() !== "absent") await this.#cli("rm", "--force", this.#name);
    await this.#cli("volume", "rm", "--force", this.#name);
  }

  command(argv: readonly string[], env: Readonly<Record<string, string>> = {}): Launch {
    const carry = carried(argv, env);
    const names = Object.keys(carry.env);
    const inside = names.length === 0 ? argv : ["sh", "-c", carry.exec, "sh", ...argv];
    return {
      argv: [this.#options.binary, "exec", "--interactive", ...names.flatMap((name) => ["--env", name]), this.#name, ...inside],
      env: carry.env,
    };
  }

  async #create(): Promise<void> {
    const { prefix, mountPath, image, limits } = this.#options;
    const labels = ["--label", `${PROVIDER_LABEL}=${prefix}`, "--label", `${OWNER_LABEL}=${this.owner}`];
    await this.#cli("volume", "create", ...labels, this.#name);
    await this.#cli(
      "create", "--name", this.#name, ...labels,
      "--hostname", "workspace",
      "--mount", `type=volume,src=${this.#name},dst=${mountPath}`,
      "--workdir", mountPath,
      "--init",
      "--security-opt", "no-new-privileges",
      ...flag("--cpus", limits?.cpus),
      ...flag("--memory", limits?.memory),
      ...flag("--pids-limit", limits?.pids),
      image,
    );
  }

  async #cli(...args: string[]): Promise<void> {
    await this.#options.cli(args);
  }
}

function flag(name: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [name, String(value)];
}

function lines(out: string): string[] {
  return out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}
