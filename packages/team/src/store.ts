/**
 * The team log: the only authority for batches, tasks, attempts and slots.
 *
 * @module @chopin/team/store
 */

import { JsonlJournal } from "@chopin/journal";
import type { JournalOptions, JournalSpec } from "@chopin/journal";

import { assertTeamEvent } from "./events.js";
import { foldTeamEvents } from "./fold.js";
import type { TeamEvent, TeamProjection } from "./types.js";

export class TeamLogCorruptError extends Error {
  constructor(readonly lineNumber: number, message: string) {
    super(`team log line ${lineNumber}: ${message}`);
    this.name = "TeamLogCorruptError";
  }
}

export class TeamLogLockError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for team log lock ${path}`);
    this.name = "TeamLogLockError";
  }
}

const TEAM_JOURNAL: JournalSpec<TeamEvent, TeamProjection> = {
  name: "Team log",
  assertEvent: assertTeamEvent,
  fold: foldTeamEvents,
  corruptError: (lineNumber, message) => new TeamLogCorruptError(lineNumber, message),
  lockError: (lockPath, timeoutMs) => new TeamLogLockError(lockPath, timeoutMs),
};

export class TeamEventStore extends JsonlJournal<TeamEvent, TeamProjection> {
  constructor(path: string, options: JournalOptions = {}) {
    super(path, TEAM_JOURNAL, options);
  }
}
