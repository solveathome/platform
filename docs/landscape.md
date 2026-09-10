# The landscape, September 2026

A survey of multi-agent frameworks, volunteer-compute and open-science swarms, and agent protocols, made on 2026-09-10 to decide what solveathome should adopt and what it should own. Web research by an agent, checked for the claims we act on; treat star counts and dates as of that day. `ROADMAP.md` is what we took from it.

## 1. Multi-agent orchestration frameworks

| Project | One line / license / traction | Worth taking | Lacks (that solveathome has) |
|---|---|---|---|
| **CrewAI** ([repo](https://github.com/crewAIInc/crewAI)) | Role crews + event Flows. MIT, 58k★. | `@persist` state and resume from any persisted state id; usage metrics rolled up across nested calls. | Single owner, private transcripts, no verification, no credit. |
| **AutoGen** ([repo](https://github.com/microsoft/autogen)) | Maintenance mode. MIT, 61k★. | Core actor runtime with a distributed variant: agents in separate processes. | Same. |
| **AG2** ([repo](https://github.com/ag2ai/ag2), [Network](https://docs.ag2.ai/docs/user-guide/network/overview/)) | "The Open-Source AgentOS." Apache-2.0, 5k★. Closest cousin. | Hub with `Passport` (name, owner, model), `Resume` (capability claims and observed track record), per-agent rules (rate limits, inbox caps), hub-stamped envelopes; "Redundant" pattern: several agents attempt the same task. | Reputation is hub-local and private; no cross-provider consensus; no citation credit. |
| **LangGraph** ([persistence](https://docs.langchain.com/oss/python/langgraph/persistence)) | Stateful agent orchestration. MIT, 41k★. | Every step a checkpoint under a thread: time travel and fork; `interrupt()` / resume. | Single graph, one owner. |
| **OpenAI Agents SDK / Swarm** ([handoffs](https://openai.github.io/openai-agents-python/handoffs/)) | MIT, 29k★. | Handoff as a tool with a typed input the model must fill and an input filter for what history the receiver sees: the cleanest "addressed ask" shape. | Vendor-locked, no owner identity. |
| **Claude Agent SDK / Managed Agents** ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents)) | MIT, 8k★. Managed Agents added outcomes: a rubric, a grader agent, work bounced back. | Hard caps (spawn depth, `max_budget_usd` as a typed error); sub-agent output scanned for injected control tags before the parent reads it. | One vendor, private. |
| **MetaGPT** ([repo](https://github.com/FoundationAgents/MetaGPT)) | MIT, 70k★, quiet since Jan 2026. | Roles subscribe to typed messages on a shared environment. | Closed team. |
| **CAMEL / OASIS** ([oasis](https://github.com/camel-ai/oasis)) | Million-agent social simulation. Apache-2.0. | Timestep activation with per-agent probability and a recommender: how a channel with thousands of agents thinks without everyone speaking every tick. | Simulation only. |
| **ChatDev 2.0** ([repo](https://github.com/OpenBMB/ChatDev)) | Apache-2.0, 34k★. | "Communicative dehallucination": ask a clarifying question before acting. | Single company sim. |
| **smolagents** ([repo](https://github.com/huggingface/smolagents)) | Apache-2.0, 29k★. | The local executor is never a security boundary: sandbox tiers. | No server, no identity. |
| **Mastra** ([suspend](https://mastra.ai/docs/workflows/suspend-and-resume)) | TS. Apache-2.0 + EE, 28k★. | Typed suspend/resume any endpoint can wake. | Single tenant. |
| **Google ADK** ([repo](https://github.com/google/adk-python)) | Apache-2.0, 21k★. | Two delegation shapes with different ownership: transfer (child owns the conversation) versus agent-as-tool (isolated, returns a string). | No public reputation. |
| **Microsoft Agent Framework** ([repo](https://github.com/microsoft/agent-framework)) | MIT, 13k★, GA Apr 2026. | Uniform Sequential/Concurrent/GroupChat/Handoff/Magentic orchestration; `select_next_agent` hook. | Enterprise single-tenant. |
| **Pydantic AI** ([repo](https://github.com/pydantic/pydantic-ai)) | MIT, 20k★. | Output validation with retry loops; pytest-style evals. | No server. |
| **Letta** ([shared memory](https://docs.letta.com/guides/agents/multi-agent-shared-memory)) | Apache-2.0, 25k★. | Shared memory blocks with two write modes: append-only insert versus last-writer-wins rethink. | No reputation. |
| **Strands** ([swarm](https://strandsagents.com/docs/user-guide/concepts/multi-agent/swarm/)) | AWS. Apache-2.0, 7k★. | Swarm with max handoffs, timeout, repetitive-handoff detection, accumulated usage. | Single owner. |
| **open-multi-agent** ([repo](https://github.com/open-multi-agent/open-multi-agent)) | "Describe the goal, not the graph." MIT, 7k★. | Per-run execution receipts (status, assignments, tokens, tool calls) with an offline viewer; admits they are not tamper-evident. | No owners, no review. |
| **Fortytwo** ([paper](https://arxiv.org/abs/2510.24801)) | Peer-ranked, reputation-weighted consensus across heterogeneous models. | Pairwise Bradley-Terry ranking beat majority vote 85.9% vs 68.7% on GPQA; proof-of-capability calibration before a node may rank. Nearest published version of our review lane; no open code found. | Not a research swarm. |
| **SwarmHarness** ([paper](https://arxiv.org/abs/2605.28764)) | | Shapley-approximated credit that drains for idle nodes. | |

## 2. Volunteer compute and open-science swarms

| Project | One line / traction | Worth taking | Lacks |
|---|---|---|---|
| **BOINC** ([site](https://boinc.berkeley.edu/), [paper](https://arxiv.org/pdf/1903.01699)) | "Compute for Science." LGPL; ~30 projects. | Minimum quorum before credit, and adaptive replication: low-error hosts get fewer redundant reruns. Reputation reduces verification cost. | Deterministic work; no reviewer of reviewers. |
| **Folding@home** ([site](https://foldingathome.org/)) | 2.4 EFLOPS peak, 500+ papers. | Points, team leaderboards, live devices-in-24h counter. | Points are not authorship. |
| **Petals** ([repo](https://github.com/bigscience-workshop/petals)) | BitTorrent-style LLM serving. MIT, dormant. | Public swarm health map. | No output verification. |
| **Prime Intellect** ([envs](https://www.primeintellect.ai/blog/environments), [TOPLOC](https://github.com/PrimeIntellect-ai/toploc)) | Decentralized RL; environments hub with bounties. | TOPLOC: locality-sensitive hash of activations verifies an untrusted rollout far cheaper than regenerating; bounty claiming via draft PR. | No review of reasoning; no credit chain. |
| **Nous Psyche** ([repo](https://github.com/PsycheFoundation/psyche)) | Apache-2.0. | Witness proofs: designated peers attest; tolerance-based dishonesty detection; coordinator ejects and reassigns. | Nothing above gradients. |
| **Gensyn / Bittensor** ([Verde](https://www.gensyn.ai/articles/verde)) | | Disputes bisect to the single disagreeing step; validators whose scores fall outside consensus lose bond. | Token-gated, opaque. |
| **Sakana AI Scientist v2** ([repo](https://github.com/SakanaAI/AI-Scientist-v2)) | First AI paper past workshop review. | Reviewer agent emits a conference-form score calibrated against human accept thresholds. | One reviewer, one owner. |
| **FutureHouse Kosmos** ([paper](https://arxiv.org/abs/2511.02824)) | 200 agents, 1,500 papers per run; 79% of statements judged accurate. | Every claim in the report links to code or primary literature. | Closed participation. |
| **Google Co-Scientist** ([blog](https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/)) | | Elo tournament via pairwise simulated debate. | Closed. |
| **Agents4Science** ([paper](https://arxiv.org/abs/2511.15534)) | AI as authors and reviewers; 315 submitted, 48 accepted. | Three cross-provider reviewers calibrated on ICLR data; one provider was 2.7 points off human calibration: provider-diverse review needs per-reviewer calibration. Four-tier AI-involvement disclosure per stage. | No cross-event reputation. |
| **Shadow evaluations** ([paper](https://arxiv.org/abs/2607.27191)) | Agents on unpublished questions, graded by the authors. | Failure modes to design against: instruction drift, poor backtracking, no resource awareness. | |
| **Polymath+AI** ([Kalai](https://gilkalai.wordpress.com/2026/04/03/polymath-plus-ai/)) | 2026 revival. | Numbered comment threads as the thinking-together channel. | No handles, no tooling. |
| **Equational Theories Project** ([repo](https://github.com/teorth/equational_theories)) | 22M implications Lean-verified. | Issues claimed by handle; CI is the verifier; status per edge on a dashboard; citing an inspiring submission qualifies both. | Human-only handles; formalizable work only. |
| **Erdős problems wiki** ([wiki](https://github.com/teorth/erdosproblems/wiki/AI-contributions-to-Erd%C5%91s-problems)) | 15 solved since Jan 2026, 11 crediting AI. | The 1(a)–1(d) AI-contribution taxonomy and a colour status; the complaint "no human has read it" is the demand signal. | Nothing automated. |
| **AlphaProof Nexus / AlphaEvolve** ([paper](https://arxiv.org/abs/2605.22763)) | | Shared sketch population rated by cheap agents ranked by Elo. | Closed. |
| **Epoch FrontierMath: Open Problems** ([about](https://epoch.ai/frontiermath/open-problems/about)) | | Significance-tiered problem registry with an editorial board. | No participation. |
| **QED / Denario** ([QED](https://github.com/proofQED/QED)) | Lean-first provers. | Lean as final arbiter so review collapses to statement alignment. | Single-owner pipelines. |

## 3. Protocols, registries, marketplaces

| Project | One line / traction | Worth taking | Lacks |
|---|---|---|---|
| **A2A v1.0** ([spec](https://a2a-protocol.org/latest/specification/)) | Linux Foundation, Apache-2.0, 26k★. | Task state machine with `input-required`; terminal tasks immutable, follow-ups are new tasks citing `referenceTaskIds`; signed agent card at a well-known URL. | No shared problem, review or reputation. |
| **MCP 2026-07** ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) | | Multi round-trip requests: a result typed `input_required` with input requests. Maps to an assignment pausing on an ask. | Point-to-point tools. |
| **MCP Registry** ([about](https://modelcontextprotocol.io/registry/about)) | | Namespaces proven by GitHub OIDC or DNS challenge; ratings left to aggregators. | Metadata only. |
| **ANP / AGNTCY / Coral** | Small. | Self-owned DID identity; content-addressed capability records; thread/mention team assembly. | Transport only. |
| **ERC-8004 Trustless Agents** ([EIP](https://eips.ethereum.org/EIPS/eip-8004), [audit](https://arxiv.org/abs/2606.26028)) | Draft; live on 20 chains. | Feedback with score, tags, off-chain file and hash. The audit found most reviewers Sybil-like: "cannot function as a trust signal." | Cross-provider consensus is the fix. |
| **Microsoft Entra Agent ID** ([docs](https://learn.microsoft.com/en-us/entra/agent-id/what-are-agent-identities)) | | Every agent has a recorded human sponsor; ownerless agents flagged. | |
| **Virtuals ACP** | Agent-hires-agent marketplace. | Job states with a paid neutral evaluator before escrow releases. | Commerce, not research. |
| **Olas / Fetch.ai / Moltbook** | | Rewards only for verified daily activity; small registration fee as anti-spam; `skill.md` + heartbeat onboarding: one markdown URL is the whole install. | Zero work verification. |

## What we take (ranked)

1. Adaptive replication (BOINC): reputation lowers how many reviews a return needs.
2. Immutable terminal returns with `referenceTaskIds` (A2A): the citation chain as a protocol field.
3. Pairwise ranking instead of score averaging (Fortytwo, Co-Scientist, AlphaProof Nexus).
4. Per-reviewer calibration across providers (Agents4Science).
5. A typed `input_required` return (MCP, OpenAI handoffs).
6. AI-contribution taxonomy and disclosure per stage (Erdős wiki, Agents4Science).
7. Reviewers out of consensus lose standing (Bittensor Yuma).
8. Sponsor handle per agent plus a calibration task before review rights (Entra, Fortytwo).
9. Every claim links to code or a primary source (Kosmos); two write modes for the swarm edition (Letta).
10. `skill.md` onboarding (Moltbook) and budget caps as typed errors (Claude Agent SDK).

## What nobody owns

1. **Owner-diverse verification.** Reviewers in the field are the same vendor or unverified. Nobody sells "reviewed by other people's models on other providers".
2. **A public ledger of reasoning.** Receipts exist, proofs exist; no project publishes transcripts, reviews and token counts per return as the default record of a research effort.
3. **Credit that flows.** Points, citation files and ratings exist; none has authorship propagating up a chain of cited returns to the paper.

## How the leaders describe themselves

A2A: "open protocol enabling communication between opaque agentic applications." CrewAI: "orchestrating role-playing, autonomous AI agents." LangGraph: "low-level orchestration framework for building stateful agents." Prime Intellect: "The Open Superintelligence Stack." Folding@home: "turns your computer's idle power into a global supercomputer." open-multi-agent: "Describe the goal, not the graph." Agents4Science: "AI serves as both primary authors and reviewers." All describe the framework or the compute. None names the problem, the crowd, or the check. Ours: "Point your agent at an open problem. Strangers' agents check its work. Credit follows the proof."
