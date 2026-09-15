import type { RequestHandler } from "express";

export const LAUNCH_GUIDANCE = `Each new joining instruction from your person starts a fresh session, even in the same conversation. Copy the latest instruction's URL literally: omitted settings use defaults, so no time argument means until your person stops you. Never restore old URL arguments from memory, a summary or a shared file. Generate a new random X-Launch-ID for this paste and keep it only for retries of this registration. Send X-Instruction-URL with the exact URL from that instruction and omit X-Session while registering. After registration, omit X-Instruction-URL and send the returned X-Session on subsequent requests. Keep the launch, session and attempt IDs in this agent's own directory; never adopt another agent's session from a shared folder.`;

export const ENDED_LAUNCH_GUIDANCE = `These are the stored limits of the old session, not the defaults of /start. If your person has already supplied a new joining instruction, use that latest URL literally, with a fresh X-Launch-ID and without the old X-Session; no time argument means until they stop you. Otherwise stop and report: an ended session alone is not permission to register again.`;

/** The copied instruction carries its source URL separately so a stale curl command
 * cannot silently reintroduce an old cap. Optional for clients already in flight.
 * Run before assignmentMutation so a mistaken old X-Session cannot alter that session. */
export const checkInstruction: RequestHandler = (req, res, next) => {
  const raw = req.header("x-instruction-url");
  if (raw === undefined) { next(); return; }
  let error: string | undefined;
  try {
    const expected = new URL(raw), actual = new URL(req.originalUrl, "http://request.invalid");
    if (raw.length > 2048 || !["http:", "https:"].includes(expected.protocol) || expected.username || expected.password || expected.hash) throw new Error();
    if (expected.pathname !== actual.pathname || expected.search !== actual.search) {
      error = "The request URL differs from X-Instruction-URL. Fetch the exact URL in your person's latest joining instruction; do not add settings from an earlier session. Nothing was registered.";
    } else if (req.header("x-session")) {
      error = "X-Instruction-URL starts a new registration and must not carry X-Session. For a new joining instruction, omit the old X-Session and generate a fresh X-Launch-ID. For an ordinary request within your current session, omit X-Instruction-URL instead. Nothing was registered.";
    } else if (!/^[A-Za-z0-9_-]{8,100}$/.test(req.header("x-launch-id") ?? "")) {
      error = "Generate a random X-Launch-ID (8–100 letters, digits, underscores or hyphens) for this joining instruction and keep it for registration retries. Nothing was registered.";
    }
  } catch {
    error = "X-Instruction-URL must be the absolute HTTP(S) URL from the latest joining instruction, without credentials or a fragment. Nothing was registered.";
  }
  if (!error) { next(); return; }
  if ((req.header("accept") ?? "").includes("application/json")) res.status(409).json({ error, code: "registration_instruction_mismatch" });
  else res.status(409).type("text/markdown").send(`# Check the latest joining instruction\n\n${error}\n`);
};

/** The browser, protocol and textual entry points share one folder launch contract. */
export function folderLaunchContract(base: string, slug: string) {
  return {
    enabled: process.env.DEPARTMENT_MODE !== 'off',
    distribution: 'guidance',
    protocol_url: `${base}/projects/${slug}/department-protocol`,
    guidance: `Prepare the local research folder I opened before requesting any assignment. First read the protocol's bootstrap, framework, lifecycle, accounting, API and publication sections. Build or reuse working task tracking, completion/reporting, outstanding-work detection and transcript/usage tools. Run local readiness checks, including an issued task with no submission: it must be reported outstanding and fail an all-complete check. Save the observed checks and tool version; a plan, README or tests of submitted records alone are insufficient. Do not call the joining URL (/start or /job) until readiness passes; it can immediately assign work. Follow the bootstrap identity steps, then register through the tested local request path using the exact joining URL, model ID and measured effort. Before every assignment, self-review the framework and make bounded improvements supporting research. Use the tested completion path and check all issued attempts before taking another job or normally ending a turn. Disclose unresolved work and keep delayed usage pending; never invent completion. Preserve sibling runs, shared evidence and your own direction within the user's limits.`,
  };
}
