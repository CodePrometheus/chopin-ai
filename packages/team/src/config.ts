/**
 * A project's team configuration: everything project-specific about team mode lives in this
 * one file inside the target repository, so the orchestrator itself carries no project
 * knowledge. Commands here are trusted configuration, like declarative toolsets.
 *
 * @module @chopin/team/config
 */

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, matchesGlob, resolve } from "node:path";
import { parse } from "yaml";

import type { DeliveryMode } from "./types.js";

/** Where the configuration lives, relative to the project root; workers may never write it. */
export const TEAM_CONFIG_PATH = ".chopin/team.yaml";

export interface SlotConfig {
  name: string;
  /** Absolute path of the worktree, resolved against the project root. */
  path: string;
}

export interface CheckRule {
  /** Path globs; a change to any matching file selects `run`. */
  paths: string[];
  run: string;
}

export interface StageConfig {
  name: string;
  /** Command that exits 0 once the stage holds for `{commit}`; omitted means a person confirms it. */
  verify?: string;
  /** How long after landing `verify` may keep failing before the stage counts as failed. */
  timeoutMinutes: number;
}

export interface TeamConfig {
  root: string;
  remote: string;
  trunk: string;
  delivery: DeliveryMode;
  slots: SlotConfig[];
  checks: CheckRule[];
  /** `ci` leaves the whole-suite check to the project's CI; `local` runs it once per batch. */
  fullCheck: { where: "local"; run: string } | { where: "ci" };
  stages: StageConfig[];
  defaults: { maxRequests: number; maxRounds: number };
  /** How often landings, stages and batch checks are looked at. */
  pollSeconds: number;
}

export class TeamConfigError extends Error {
  constructor(message: string) {
    super(`${TEAM_CONFIG_PATH}: ${message}`);
    this.name = "TeamConfigError";
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(message: string): never {
  throw new TeamConfigError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be a mapping`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${what} must be a non-empty string`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} must be a list`);
  return value;
}

function positive(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${what} must be a positive integer`);
  return value;
}

function unique(names: string[], what: string): void {
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) fail(`${what} ${duplicate} appears twice`);
}

/** Validate a parsed configuration and resolve its slot paths against `root`. */
export function parseTeamConfig(raw: unknown, root: string): TeamConfig {
  const config = record(raw, "the configuration");
  const slots = list(config.slots, "slots").map((value, index) => {
    const slot = record(value, `slots[${index}]`);
    const name = text(slot.name, `slots[${index}].name`);
    if (!NAME.test(name)) fail(`slots[${index}].name must be a lowercase slug`);
    const path = text(slot.path, `slots[${index}].path`);
    return { name, path: isAbsolute(path) ? path : resolve(root, path) };
  });
  if (slots.length === 0) fail("slots must list at least one worktree");
  unique(slots.map((slot) => slot.name), "slot");
  unique(slots.map((slot) => slot.path), "slot path");

  const delivery = config.delivery ?? "local";
  if (delivery !== "local" && delivery !== "push" && delivery !== "pull-request") fail("delivery must be local, push or pull-request");

  const checks = list(config.checks ?? [], "checks").map((value, index) => {
    const rule = record(value, `checks[${index}]`);
    const paths = list(rule.paths, `checks[${index}].paths`).map((path, at) => text(path, `checks[${index}].paths[${at}]`));
    if (paths.length === 0) fail(`checks[${index}].paths must not be empty`);
    return { paths, run: text(rule.run, `checks[${index}].run`) };
  });

  const full = record(config.fullCheck ?? {}, "fullCheck");
  const where = full.where ?? "local";
  let fullCheck: TeamConfig["fullCheck"];
  if (where === "ci") fullCheck = { where: "ci" };
  else if (where === "local") fullCheck = { where: "local", run: text(full.run, "fullCheck.run") };
  else fail("fullCheck.where must be local or ci");

  const stages = list(config.stages ?? [], "stages").map((value, index) => {
    const stage = record(value, `stages[${index}]`);
    const name = text(stage.name, `stages[${index}].name`);
    if (!NAME.test(name)) fail(`stages[${index}].name must be a lowercase slug`);
    const timeoutMinutes = stage.timeoutMinutes === undefined ? 60 : positive(stage.timeoutMinutes, `stages[${index}].timeoutMinutes`);
    return stage.verify === undefined ? { name, timeoutMinutes } : { name, verify: text(stage.verify, `stages[${index}].verify`), timeoutMinutes };
  });
  unique(stages.map((stage) => stage.name), "stage");

  const defaults = record(config.defaults ?? {}, "defaults");
  return {
    root,
    remote: config.remote === undefined ? "origin" : text(config.remote, "remote"),
    trunk: config.trunk === undefined ? "main" : text(config.trunk, "trunk"),
    delivery,
    slots,
    checks,
    fullCheck: fullCheck!,
    stages,
    defaults: {
      maxRequests: defaults.maxRequests === undefined ? 60 : positive(defaults.maxRequests, "defaults.maxRequests"),
      maxRounds: defaults.maxRounds === undefined ? 6 : positive(defaults.maxRounds, "defaults.maxRounds"),
    },
    pollSeconds: config.pollSeconds === undefined ? 60 : positive(config.pollSeconds, "pollSeconds"),
  };
}

export async function loadTeamConfig(root: string): Promise<TeamConfig> {
  let source: string;
  try {
    source = await readFile(resolve(root, TEAM_CONFIG_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`not found under ${root}; team mode needs it`);
    throw error;
  }
  return parseTeamConfig(parse(source), root);
}

/** The nearest directory at or above `cwd` that holds a team configuration. */
export async function findTeamRoot(cwd: string): Promise<string | undefined> {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    try {
      await access(resolve(directory, TEAM_CONFIG_PATH));
      return directory;
    } catch {
      if (dirname(directory) === directory) return undefined;
    }
  }
}

function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(file, glob));
}

/** The check commands a set of changed files selects, in configuration order and without repeats. */
export function affectedChecks(config: TeamConfig, changedFiles: readonly string[]): string[] {
  return config.checks.filter((rule) => changedFiles.some((file) => matchesAny(file, rule.paths))).map((rule) => rule.run)
    .filter((run, index, runs) => runs.indexOf(run) === index);
}

/**
 * Changed files a task may not deliver: the team configuration, another task's acceptance
 * checks, and anything outside its write scope. Its own checks are exempt from the scope;
 * their content is verified against the recorded digests instead.
 */
export function scopeViolations(changedFiles: readonly string[], writeScope: readonly string[],
  ownChecks: readonly string[], otherChecks: readonly string[]): string[] {
  return changedFiles.filter((file) => file === TEAM_CONFIG_PATH || otherChecks.includes(file)
    || (!ownChecks.includes(file) && !matchesAny(file, writeScope)));
}
