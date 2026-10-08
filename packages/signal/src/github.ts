import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceAdapter } from "./adapter.js";
import { newRequestId } from "./manual.js";
import type { InvestigationRequest } from "./types.js";

const execFileAsync = promisify(execFile);

interface GhIssue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
}

/** Signed GCS bundle links expire after 7 days; grab every zip URL in the body. */
const ZIP_URL_RE = /https:\/\/storage\.googleapis\.com\/\S+?\.zip\S*/g;

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function issueToRequest(repo: string, issueNumber: number): Promise<InvestigationRequest> {
  const raw = await gh([
    "issue", "view", String(issueNumber),
    "--repo", repo,
    "--json", "number,title,body,createdAt",
  ]);
  const issue = JSON.parse(raw) as GhIssue;
  const bundles = issue.body.match(ZIP_URL_RE) ?? [];
  return {
    id: newRequestId(`issue-${issueNumber}`),
    source: { kind: "github-issue", ref: `${repo}#${issueNumber}` },
    symptom: `${issue.title}\n\n${issue.body.slice(0, 2000)}`,
    evidencePointers: bundles,
    createdAt: new Date().toISOString(),
  };
}

/** Issues assigned to the current gh user: the polling entry point for triage. */
export async function listAssignedIssues(repo: string): Promise<Array<{ number: number; title: string }>> {
  const raw = await gh([
    "issue", "list",
    "--repo", repo,
    "--assignee", "@me",
    "--state", "open",
    "--json", "number,title",
  ]);
  return JSON.parse(raw) as Array<{ number: number; title: string }>;
}

/** GitHub source adapter: open issues assigned to me, one investigation request each. */
export function createGithubAdapter(options: { repo: string }): SourceAdapter {
  return {
    name: `github:${options.repo}`,
    available: async () => {
      try {
        await gh(["auth", "status"]);
        return true;
      } catch {
        return false;
      }
    },
    poll: async () => {
      // One list call brings the body along, so no separate view per issue
      const raw = await gh([
        "issue", "list",
        "--repo", options.repo,
        "--assignee", "@me",
        "--state", "open",
        "--json", "number,title,body,createdAt",
      ]);
      const issues = JSON.parse(raw) as GhIssue[];
      return issues.map((issue) => ({
        id: newRequestId(`issue-${issue.number}`),
        source: { kind: "github-issue" as const, ref: `${options.repo}#${issue.number}` },
        symptom: `${issue.title}\n\n${(issue.body ?? "").slice(0, 2000)}`,
        evidencePointers: (issue.body ?? "").match(ZIP_URL_RE) ?? [],
        createdAt: new Date().toISOString(),
      }));
    },
  };
}
