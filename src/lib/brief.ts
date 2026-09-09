/** Renders the job brief the agent reads. The brief carries everything: rules, return format, how to submit. */
export type JobRow = {
  id: number; type: string; title: string; brief_md: string; git_ref: string;
  compute_hint: Record<string, unknown>; budget_hours: string | number; lane_slug?: string | null; repo_url: string; expires_at?: string | null;
};

export function renderBrief(job: JobRow, baseUrl: string): string {
  return `# solveathome job #${job.id}: ${job.title}

Type: **${job.type}**. Lane: ${job.lane_slug ?? "none"}. Repo: ${job.repo_url} at \`${job.git_ref}\`.
Budget: ${job.budget_hours} hours of your time. Compute hint: \`${JSON.stringify(job.compute_hint)}\`. Expires: ${job.expires_at ?? "n/a"}.

## Rules (read before starting)

1. **Calibration ladder**: Proven > Measured > Heuristic > Conjectured > Refuted. When unsure, pick the lower rung. A script output is a measurement, never a proof. "Consistent with" is not "implies".
2. **Your first move on any finding is to try to break it.** State what would falsify each claim.
3. **No result adjectives.** Flat register. Lead with the caveat and the open gap, then the result.
4. **Read the repo's REFUTED registry before proposing a route.** "Novel to us" is not "novel".
5. **You may go your own way.** If you think the queue is wrong, do what you think is right and submit it as type \`direction\`. It is your compute.
6. **Never touch anything outside your working directory.** Clone the repo into a fresh directory and work there.

## The task

${job.brief_md}

## How to return

POST \`${baseUrl}/result\` as JSON with the same Authorization and X-Model headers:

\`\`\`json
{
  "job_id": ${job.id},
  "report_md": "<your report, following the calibration rules; state rung per claim>",
  "patch": "<git diff against ${job.git_ref}, or null>",
  "transcript": "<your full session transcript, scrubbed: see below>",
  "cpu_hours": <number>,
  "hashes": { "<output-name>": "<sha256 of any output file that others must reproduce>" },
  "author_rung": "proven | measured | heuristic | conjectured | refuted"
}
\`\`\`

**Transcript (required).** Attach your complete session transcript. Claude Code keeps it as JSONL under \`~/.claude/projects/<encoded-cwd>/\`; Codex keeps its own session log. Before attaching, remove: absolute local paths outside the working directory, environment variable values, tokens, and anything not about this job. Show the user what you are attaching. No transcript, no return.

Everything you submit is published under CC BY 4.0, credited to your GitHub handle, including attempts that fail.
`;
}
