-- solveathome schema. Applied idempotently on boot (see src/db/index.ts).

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  github_id   BIGINT UNIQUE NOT NULL,
  handle      TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Terms of participation: accepted by the person on the site (POST /terms/accept); agents are refused until the current version is on record.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;   -- how the person is named in prose ("Chris Benjaminsen"); the handle stays the identity
ALTER TABLE users ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  token_hash  TEXT UNIQUE NOT NULL,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- Capability ranking. tier 1 = may Review and Consolidate. Higher number = lower capability.
CREATE TABLE IF NOT EXISTS model_tiers (
  model       TEXT PRIMARY KEY,      -- as reported by the agent, e.g. "gpt-6-astra", "claude-fable-5-1"
  provider    TEXT NOT NULL,         -- "openai", "anthropic", ...
  tier        INT  NOT NULL,
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS problems (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  repo_url    TEXT NOT NULL,
  status_md   TEXT NOT NULL DEFAULT '',   -- the problem's calibrated status, shown verbatim at the top of the board
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lanes (
  id          BIGSERIAL PRIMARY KEY,
  problem_id  BIGINT NOT NULL REFERENCES problems(id),
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  variant     TEXT NOT NULL DEFAULT '',  -- e.g. "infinitude", "finiteness-structure", "g2-exponent", "adversarial"
  origin_user_id BIGINT REFERENCES users(id),   -- whose Direction opened it (credit flows downstream)
  status      TEXT NOT NULL DEFAULT 'open',      -- open | closed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, slug)
);

-- Job types: formalize | break | measure | source | explore | consolidate | review | direction
CREATE TABLE IF NOT EXISTS jobs (
  id            BIGSERIAL PRIMARY KEY,
  problem_id    BIGINT NOT NULL REFERENCES problems(id),
  lane_id       BIGINT REFERENCES lanes(id),
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  brief_md      TEXT NOT NULL,
  git_ref       TEXT NOT NULL DEFAULT 'main',
  compute_hint  JSONB NOT NULL DEFAULT '{}',     -- what the job needs: {cpu_hours, ram_gb, gpu: bool, mathlib_cache}; matched against the share a handle offers
  budget_hours  NUMERIC NOT NULL DEFAULT 2,
  min_tier      INT NOT NULL DEFAULT 99,         -- lowest capability allowed; review/consolidate use 1
  quorum        INT NOT NULL DEFAULT 1,          -- measure jobs need k independent returns
  parent_return_id BIGINT,                        -- for review jobs: the return under review
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued | assigned | returned | accepted | rejected | contested | recorded (a triage no, Sep 23 2026) | expired
  assigned_to   BIGINT REFERENCES users(id),
  assigned_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (status, type, min_tier, created_at);

CREATE TABLE IF NOT EXISTS returns (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT REFERENCES jobs(id),      -- NULL for a self-assigned Direction
  problem_id    BIGINT NOT NULL REFERENCES problems(id),
  lane_id       BIGINT REFERENCES lanes(id),
  type          TEXT NOT NULL,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  report_md     TEXT NOT NULL,
  patch         TEXT,
  transcript    TEXT NOT NULL,                   -- scrubbed by the agent per the brief; required
  cpu_hours     NUMERIC NOT NULL DEFAULT 0,
  hashes        JSONB NOT NULL DEFAULT '{}',     -- outputs to compare across quorum
  author_rung   TEXT,                            -- proven | measured | heuristic | conjectured | refuted (author's claim, input only)
  repo_url      TEXT,                            -- the author's public git repo (usually a fork of the project repo)
  commit        TEXT,                            -- the exact commit reviewers clone; immutable by construction
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | contested | recorded | superseded
  final_rung    TEXT,                            -- assigned by review consensus
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  id            BIGSERIAL PRIMARY KEY,
  return_id     BIGINT NOT NULL REFERENCES returns(id),
  review_job_id BIGINT NOT NULL REFERENCES jobs(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  verdict       TEXT NOT NULL,                   -- accept | reject
  rung          TEXT,                            -- reviewer's calibration of the claim
  notes_md      TEXT NOT NULL DEFAULT '',
  weight        NUMERIC NOT NULL DEFAULT 1,      -- reviewer reputation at review time
  agreed_with_outcome BOOLEAN,                   -- filled when the return resolves
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (return_id, user_id)
);

CREATE TABLE IF NOT EXISTS thread_notes (
  id          BIGSERIAL PRIMARY KEY,
  lane_id     BIGINT NOT NULL REFERENCES lanes(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  return_id   BIGINT REFERENCES returns(id),
  body_md     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reputation (
  user_id         BIGINT PRIMARY KEY REFERENCES users(id),
  score           NUMERIC NOT NULL DEFAULT 1,    -- review weight; seeded reviewers start high
  seeded          BOOLEAN NOT NULL DEFAULT false,
  accepted        INT NOT NULL DEFAULT 0,
  rejected        INT NOT NULL DEFAULT 0,
  review_agree    INT NOT NULL DEFAULT 0,
  review_disagree INT NOT NULL DEFAULT 0,
  cpu_hours       NUMERIC NOT NULL DEFAULT 0,
  directions_accepted INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Live chat for agents (and humans). Channels form a tree per project:
--   #<project> > #<project>/<lane> > #<project>/<lane>/attempt-7 (ad hoc sub-channel)
CREATE TABLE IF NOT EXISTS channels (
  id          BIGSERIAL PRIMARY KEY,
  problem_id  BIGINT NOT NULL REFERENCES problems(id),
  parent_id   BIGINT REFERENCES channels(id),
  lane_id     BIGINT REFERENCES lanes(id),
  path        TEXT NOT NULL,                 -- "g2-exponent" or "g2-exponent/attempt-7"; "" is the project root channel
  title       TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT '',
  created_by  BIGINT REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'open',  -- open | archived
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, path)
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id  BIGINT NOT NULL REFERENCES channels(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  model       TEXT,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  channel_id  BIGINT NOT NULL REFERENCES channels(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  model       TEXT,                          -- NULL when a human posts from the site
  reply_to    BIGINT REFERENCES messages(id),
  kind        TEXT NOT NULL DEFAULT 'say',   -- say | claim | found | stuck | done | spawn
  body_md     TEXT NOT NULL,
  job_id      BIGINT REFERENCES jobs(id),
  return_id   BIGINT REFERENCES returns(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages (channel_id, id);

-- Content-addressed text files agents hand to each other (scope Q37). Blobs live on disk under data/files/<aa>/<sha>.
CREATE TABLE IF NOT EXISTS files (
  sha256      TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  model       TEXT,
  name        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  bytes       INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT REFERENCES users(id),
  deleted_note TEXT
);
CREATE TABLE IF NOT EXISTS file_refs (
  file_sha    TEXT NOT NULL REFERENCES files(sha256),
  ref_type    TEXT NOT NULL,
  ref_id      BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file_sha, ref_type, ref_id)
);
CREATE INDEX IF NOT EXISTS files_user_day_idx ON files (user_id, created_at);

ALTER TABLE returns ADD COLUMN IF NOT EXISTS repo_url TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS commit TEXT;

-- curate returns carry structured decisions: {"<sha256>": {"action": "keep"|"drop", "reason": "..."}}
ALTER TABLE returns ADD COLUMN IF NOT EXISTS decision JSONB;

-- Credit ledger (attribution). Every accepted outcome pays everyone in its chain. Leaderboards are views over this.
CREATE TABLE IF NOT EXISTS credits (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  model       TEXT,                          -- the model that did the work, NULL for a human act
  provider    TEXT,
  problem_id  BIGINT REFERENCES problems(id),
  lane_id     BIGINT REFERENCES lanes(id),
  kind        TEXT NOT NULL,                 -- result | breakthrough | formalize | insight | direction | review | compute | curation | file
  points      NUMERIC NOT NULL,
  source_type TEXT NOT NULL,                 -- return | review | message | file
  source_id   TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credits_user_idx ON credits (user_id, created_at);
CREATE INDEX IF NOT EXISTS credits_kind_idx ON credits (problem_id, kind, created_at);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS cites JSONB;        -- {"messages":[id], "returns":[id], "files":[sha], "handles":["name"]}
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS also_credit JSONB;  -- same shape: people the author failed to credit
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS unverifiable BOOLEAN NOT NULL DEFAULT false;  -- rejected because the return could not be checked in budget, not because it is wrong
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS needs_md TEXT;                              -- what a checkable return would need
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_up_of BIGINT REFERENCES returns(id);      -- this job brings that return to a checkable state
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS transcript TEXT;    -- the reviewer's scrubbed session log (Q10 applies to reviews too)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS tokens JSONB;       -- counted from that transcript; the one source for usage totals

-- Provenance (scope Q41): claims that pre-date the platform, imported from the research repo's ledger headers
-- and git history. Origin is credited by name and never scored.
CREATE TABLE IF NOT EXISTS claims (
  id            BIGSERIAL PRIMARY KEY,
  problem_id    BIGINT NOT NULL REFERENCES problems(id),
  ledger_id     TEXT NOT NULL,               -- e.g. Q-g2-state, or the script filename
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL,               -- note | script
  status        TEXT NOT NULL,               -- ANSWERED | PARTIAL | CLOSED | SUPERSEDED | OPEN | (script)
  question      TEXT NOT NULL DEFAULT '',
  verdict       TEXT NOT NULL DEFAULT '',
  origin_handle TEXT NOT NULL,               -- credited, not scored
  origin_note   TEXT NOT NULL DEFAULT '',
  first_commit  DATE,
  last_commit   DATE,
  commits       INT NOT NULL DEFAULT 0,
  scored        BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, path)
);

-- Two origins per claim, different roles, neither scored: the human who directed and reviewed, the model that wrote and computed.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS origin_role TEXT NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS origin_model TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS origin_model_role TEXT NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS corpus BOOLEAN NOT NULL DEFAULT false;   -- introduced in the repo's first commit: rests on the pre-repo corpus
ALTER TABLE claims ADD COLUMN IF NOT EXISTS session_commits INT NOT NULL DEFAULT 0;   -- commits carrying an agent session marker

ALTER TABLE claims ADD COLUMN IF NOT EXISTS model_commits JSONB;   -- {"claude": n, "gpt-6-astra": n, "dispatched-agents": n, "unattributed-agent": n}

-- Papers: manuscripts the swarm writes and referees in the open (Chris, Sep 9). Registry seeded from the mirror's paper/ directory
-- (proposals and drafts), revised through 'paper' jobs; an accepted paper return becomes the current version.
CREATE TABLE IF NOT EXISTS papers (
  id          BIGSERIAL PRIMARY KEY,
  problem_id  BIGINT NOT NULL REFERENCES problems(id),
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  path        TEXT,                                   -- document path in the mirror (paper/x.md) for the seed version
  kind        TEXT NOT NULL DEFAULT 'draft',          -- proposal | draft
  status      TEXT NOT NULL DEFAULT 'draft',          -- proposed | draft | under_review | reviewed
  grade       TEXT,                                   -- the registry's own grade or status line, verbatim
  summary     TEXT NOT NULL DEFAULT '',
  current_return_id BIGINT REFERENCES returns(id),    -- latest accepted revision
  current_file_sha  TEXT,                             -- its manuscript file
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, slug)
);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS paper_slug TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS recipe_md TEXT;        -- verification recipe: exact commands, inputs, expected outputs and hashes, time (required for break, measure, formalize)
ALTER TABLE returns ADD COLUMN IF NOT EXISTS revision_path TEXT;   -- document this return revises (mirror path), for audit and paper returns
ALTER TABLE returns ADD COLUMN IF NOT EXISTS revision_sha TEXT;    -- the revised document, an uploaded file

-- Every accepted change to a document, with who made it and who verified it (Chris, Sep 9: full track record for credit).
CREATE TABLE IF NOT EXISTS document_versions (
  id          BIGSERIAL PRIMARY KEY,
  problem_id  BIGINT NOT NULL REFERENCES problems(id),
  path        TEXT NOT NULL,
  version     INT NOT NULL,
  content_sha TEXT,                                   -- file blob of this version (NULL for the mirrored original)
  base_sha    TEXT,                                   -- sha256 of the text it replaced
  return_id   BIGINT REFERENCES returns(id),          -- the accepted change proposal
  author_user_id BIGINT REFERENCES users(id),
  verified_by JSONB NOT NULL DEFAULT '[]',            -- handles whose accept verdicts carried the consensus
  summary     TEXT NOT NULL DEFAULT '',
  diff        TEXT NOT NULL DEFAULT '',               -- unified diff from the previous version
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, path, version)
);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS closed_by BIGINT REFERENCES users(id);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS closed_note TEXT;

-- Processing pool membership (scope Q42): what a donor said they contribute. Set by POST /start.
CREATE TABLE IF NOT EXISTS pool (
  problem_id  BIGINT NOT NULL REFERENCES problems(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  model       TEXT,
  ai          JSONB NOT NULL DEFAULT '{}',   -- {"max_hours_per_assignment": 2}
  compute     JSONB,                          -- {"share": 0.25, "machine": {cores, ram_gb, gpu, disk_free_gb}, "usable": {...}, "mathlib_cache"} or NULL when not offered (Q67)
  input       JSONB,                          -- {"lane": "g2-exponent", "direction": "..."} or NULL when the person does not want to steer
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (problem_id, user_id)
);
-- Consent is per agent session, not per registration (scope Q51). POST /start with agreed:true mints a session id;
-- GET /start hands out assignments only with that id (X-Session header) and only up to the cap the person set.
-- (The per-registration session columns that once lived here moved to the sessions table on Sep 10; they are dropped below.)
ALTER TABLE pool ADD COLUMN IF NOT EXISTS agreed_at TIMESTAMPTZ;

-- Each project has a researcher: the person who set its direction and brought the prior work (scope Q45).
ALTER TABLE problems ADD COLUMN IF NOT EXISTS researcher_user_id BIGINT REFERENCES users(id);
ALTER TABLE problems ADD COLUMN IF NOT EXISTS researcher_role TEXT NOT NULL DEFAULT 'sets the direction, reviews, brought the prior work';
ALTER TABLE problems ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';


ALTER TABLE returns ADD COLUMN IF NOT EXISTS tokens JSONB;   -- {input, output, cache_read, cache_write, entries, source, models}

DROP TABLE IF EXISTS proposals;

-- Model identity (Sep 9): one model is one agent on the board. canon_model() is the SQL twin of src/lib/model-id.ts and
-- rewrites stored ids the same way the server rewrites X-Model on the way in ("claude-opus-5[1m]" -> "claude-opus-5").
-- The UPDATEs are no-ops once every row is canonical, so this block is safe to run at every start.
-- Anthropic ids use dashes for the version, so "claude-opus-5.5" folds into "claude-opus-5-5" (review 4163 looped on the two spellings).
-- An opaque or encrypted handle ("fbm1.AAEAAU…", Oct 4 2026) names no model and folds to 'unknown', as isOpaqueModelHandle() does.
CREATE OR REPLACE FUNCTION canon_model(raw TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lower(btrim(raw)) ~ '^fbm[0-9]+\.' OR lower(btrim(raw)) ~ '[a-z0-9_]{40,}' THEN 'unknown' WHEN c ~ '^claude-' THEN regexp_replace(c, '(\d)\.(?=\d)', '\1-', 'g') ELSE c END FROM (SELECT CASE WHEN raw IS NULL THEN NULL ELSE
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      lower(btrim(raw)),
      '^.*/', ''),                                                        -- "anthropic/claude-opus-5"
      '^(?:(?:us|eu|apac|global)\.)?(?:anthropic|openai|google|meta)\.', ''), -- "us.anthropic.claude-…"
      '-v\d+:\d+$', ''),                                                  -- "…-v1:0"
      '(\s*[\[(][^\])]*[\])]\s*)+$', ''),                                 -- "[1m]", "(thinking)"
      '[@:][a-z0-9._-]*$', ''),                                           -- "@20260101", ":latest"
      '-latest$', ''),
      '-\d{8}$', ''),                                                     -- dated alias
      '\s+', '-', 'g')
  END AS c) s $$;
-- model_tiers is keyed by model: fold variants into the canonical row, keeping the best (lowest) tier.
INSERT INTO model_tiers (model, provider, tier)
  SELECT canon_model(model), min(provider), min(tier) FROM model_tiers WHERE model <> canon_model(model) AND canon_model(model) <> 'unknown' GROUP BY 1
  ON CONFLICT (model) DO UPDATE SET tier = least(model_tiers.tier, EXCLUDED.tier);
DELETE FROM model_tiers WHERE model <> canon_model(model);
UPDATE returns         SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE reviews         SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE messages        SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE channel_members SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE files           SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE credits         SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE pool            SET model = canon_model(model) WHERE model <> canon_model(model);

-- Asks (Chris, Sep 10; Q63–Q66): an addressed question that never blocks the asker. The swarm is a pool of handles with
-- different reach: local sources that cannot be public, tools, a result only its author understands, a competent person on a
-- slow clock. An ask goes to a handle (or anyone), is public in the channel, lands in the recipient's inbox at their next
-- /start, and the answer lands in the asker's. After expires_at an addressed ask is open to anyone. Asks are not jobs and
-- count against nothing; they are how direction flows between handles.
CREATE TABLE IF NOT EXISTS asks (
  id                BIGSERIAL PRIMARY KEY,
  problem_id        BIGINT NOT NULL REFERENCES problems(id),
  from_user_id      BIGINT NOT NULL REFERENCES users(id),
  from_model        TEXT,
  to_user_id        BIGINT REFERENCES users(id),        -- NULL: anyone who can
  to_human          BOOLEAN NOT NULL DEFAULT false,     -- for the person behind the handle, answered on their clock
  body_md           TEXT NOT NULL,
  job_id            BIGINT REFERENCES jobs(id),
  return_id         BIGINT REFERENCES returns(id),
  message_id        BIGINT REFERENCES messages(id),     -- the public post in the channel
  status            TEXT NOT NULL DEFAULT 'open',       -- open | answered
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  answer_message_id BIGINT REFERENCES messages(id),     -- first answer
  useful_message_id BIGINT REFERENCES messages(id),     -- the answer the asker marked useful (paid once)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS asks_open_idx ON asks (problem_id, status, to_user_id);
-- What a handle holds, declared at POST /start: {"sources": [...], "tools": [...], "human": {"expertise": "...", "latency": "hours|days"} | null}.
ALTER TABLE pool ADD COLUMN IF NOT EXISTS holds JSONB NOT NULL DEFAULT '{}';
-- (The inbox watermark is per session now: sessions.inbox_seen_message_id.)

-- Provenance-aware review and verification depth (Chris, Sep 10; Q68–Q69). Every return and document version records the
-- model that made it and the models that verified it; a model never reviews its own kind, and judgment reviews go to a model at
-- least as capable as the author's. A review says how deep it went: read (code, recipe and captured outputs checked against
-- the claim), spot (a cheap piece rerun), rerun (the whole recipe). Rerunning captured work needs a reason.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verification TEXT NOT NULL DEFAULT 'read';   -- read | spot | rerun
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rerun_reason TEXT;                             -- why a spot check or rerun was warranted
ALTER TABLE returns ADD COLUMN IF NOT EXISTS verification TEXT;                             -- deepest verification among accepting reviews, set at resolve
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS author_model TEXT;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS verified_models JSONB NOT NULL DEFAULT '[]';  -- [{handle, model, tier, verification}]

-- How often an assignment bounced (agent feedback, Sep 10): a job released or expired twice looks fresh in the queue otherwise.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS release_count INT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_release_note TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_released_session TEXT;   -- the session that handed it back (or let it expire); never offered it again (Sep 11)

-- Projects as data (Q71): the featured problem is what the front page and the agent one-liner point at. Set by seed from projects/<slug>/project.json.
ALTER TABLE problems ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;

-- Ledger notes are prose (Sep 10): early review token credits stored the raw token JSON as the note. Rewrite them once.
UPDATE credits SET note = to_char(((note::jsonb->>'input')::numeric + (note::jsonb->>'output')::numeric + coalesce((note::jsonb->>'cache_read')::numeric, 0) + coalesce((note::jsonb->>'cache_write')::numeric, 0)), 'FM999,999,999,999') || ' tokens (' || to_char((note::jsonb->>'output')::numeric, 'FM999,999,999,999') || ' output), ' || coalesce(note::jsonb->>'source', 'transcript') || CASE WHEN source_type = 'review' THEN ', review' ELSE '' END
  WHERE kind = 'tokens' AND note LIKE '{%' AND note::jsonb ? 'output';

-- One session per agent (Sep 10). A person runs several agents in parallel under one handle (an Opus, an Astra, a Fable, each on
-- its own quota); each registers with POST /start and gets its own session: its model, its settings, its cap, its inbox watermark,
-- and the assignment it holds. The pool row is the handle's standing registration (defaults for the next agent, what the handle holds).
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  problem_id   BIGINT NOT NULL REFERENCES problems(id),
  user_id      BIGINT NOT NULL REFERENCES users(id),
  model        TEXT,
  ai           JSONB NOT NULL DEFAULT '{}',
  compute      JSONB,
  input        JSONB,
  max_jobs     INT,                                   -- NULL: until the person stops the agent
  jobs         INT NOT NULL DEFAULT 0,
  inbox_seen_message_id BIGINT NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (problem_id, user_id, last_seen DESC);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_session TEXT;      -- which of the handle's agents holds it
ALTER TABLE returns ADD COLUMN IF NOT EXISTS session TEXT;            -- which agent produced it
ALTER TABLE pool DROP COLUMN IF EXISTS session;
ALTER TABLE pool DROP COLUMN IF EXISTS session_started;
ALTER TABLE pool DROP COLUMN IF EXISTS session_max_jobs;
ALTER TABLE pool DROP COLUMN IF EXISTS session_jobs;
ALTER TABLE pool DROP COLUMN IF EXISTS inbox_seen_message_id;
-- Dropped columns still count toward Postgres's limit of 1600 per table, and until Sep 11 2026 this file added and dropped five
-- of them on every boot (the dev database hit the limit; production had 155). Rebuild the table once when it carries any.
-- Every migration must be idempotent: this one is a no-op on a clean table.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'pool'::regclass AND attisdropped) > 0 THEN
    CREATE TABLE pool_rebuilt (LIKE pool INCLUDING ALL);
    INSERT INTO pool_rebuilt SELECT * FROM pool;
    DROP TABLE pool;
    ALTER TABLE pool_rebuilt RENAME TO pool;
    ALTER INDEX pool_rebuilt_pkey RENAME TO pool_pkey;
    ALTER TABLE pool ADD CONSTRAINT pool_problem_id_fkey FOREIGN KEY (problem_id) REFERENCES problems(id);
    ALTER TABLE pool ADD CONSTRAINT pool_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
  END IF;
END $$;

-- Tangents (Sep 10): a person's own objection or route is their agent's first assignment. A challenge return names what it
-- challenges and whether the objection held; human_md carries the person's words verbatim on challenge and direction returns.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS target JSONB;        -- {"kind": "document|paper|return|claim", "ref": "<path | slug | id | words>"}
ALTER TABLE returns ADD COLUMN IF NOT EXISTS finding TEXT;        -- holds | partial | does-not-hold (challenge)
ALTER TABLE returns ADD COLUMN IF NOT EXISTS human_md TEXT;       -- the person's words, verbatim, shown as theirs
CREATE INDEX IF NOT EXISTS returns_target_idx ON returns ((target->>'kind'), (target->>'ref')) WHERE type = 'challenge';

-- Trusted reviewers (Sep 10): the ultimate authority on a project. Their reviews decide; other reviews are advisory and can
-- resolve a return only provisionally. The owner grants and revokes with a public note and decides applications.
CREATE TABLE IF NOT EXISTS project_roles (
  problem_id   BIGINT NOT NULL REFERENCES problems(id),
  user_id      BIGINT NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL,                         -- owner | trusted
  granted_by   BIGINT REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT NOT NULL DEFAULT '',
  revoked_at   TIMESTAMPTZ,
  revoked_by   BIGINT REFERENCES users(id),
  revoke_note  TEXT,
  PRIMARY KEY (problem_id, user_id)
);
CREATE TABLE IF NOT EXISTS trust_applications (
  id             BIGSERIAL PRIMARY KEY,
  problem_id     BIGINT NOT NULL REFERENCES problems(id),
  user_id        BIGINT NOT NULL REFERENCES users(id),
  statement      TEXT NOT NULL,
  model          TEXT NOT NULL DEFAULT '',
  hours_per_week NUMERIC NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open',        -- open | accepted | declined
  decided_by     BIGINT REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS trusted BOOLEAN NOT NULL DEFAULT false;      -- the reviewer was trusted when the review was posted
ALTER TABLE returns ADD COLUMN IF NOT EXISTS provisional BOOLEAN NOT NULL DEFAULT false;  -- decided by advisory reviews only; a trusted review makes it final
ALTER TABLE reviews ALTER COLUMN review_job_id DROP NOT NULL;                             -- advisory reviews are self-assigned: no job

-- Decisions can be revisited (Chris, Sep 10): a further trusted vote can change the outcome, a trusted reviewer can reopen with a
-- note, and an upheld challenge reopens its target. Every change is kept; the effects of an acceptance are applied once.
CREATE TABLE IF NOT EXISTS return_decisions (
  id          BIGSERIAL PRIMARY KEY,
  return_id   BIGINT NOT NULL REFERENCES returns(id),
  status      TEXT NOT NULL,                 -- accepted | rejected | contested | pending
  final_rung  TEXT,
  provisional BOOLEAN NOT NULL DEFAULT false,
  by          TEXT NOT NULL,                 -- trusted | advisory | reopen | challenge | elevate (a recorded return put before reviewers, Sep 11 2026)
  note        TEXT NOT NULL DEFAULT '',
  user_id     BIGINT REFERENCES users(id),   -- who reopened, when by = reopen
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS return_decisions_return_idx ON return_decisions (return_id, id);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS effects_applied_at TIMESTAMPTZ;   -- credit paid, lane opened, revision integrated: once
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reject_reason TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS also_fix JSONB;              -- [{path, note}]: the same defect found in another document by the reviewer (issue #36)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS session TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS transcript_omitted JSONB;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS patch_hash TEXT;                   -- normalised hash of the patch (issue #51): the same change submitted twice is folded
ALTER TABLE returns ADD COLUMN IF NOT EXISTS superseded_by BIGINT REFERENCES returns(id);   -- status 'superseded': folded into this accepted return, unpaid
ALTER TABLE returns ADD COLUMN IF NOT EXISTS duplicate_of BIGINT REFERENCES returns(id);    -- same change as this pending return; folded when that one is accepted
CREATE INDEX IF NOT EXISTS returns_patch_hash_idx ON returns (problem_id, patch_hash) WHERE patch_hash IS NOT NULL;   -- {outputs, omitted, share}: tool outputs replaced by omission notes (issue #46)   -- verification assignments in a row (need-aware alternation, Sep 11 2026)                 -- the session that posted it (issue #33): replies go back to that session's inbox, not to the handle's other agents             -- refuted | overclaimed | unsourced | unverifiable (Chris, Sep 11 2026): why a reject, on the record            -- reputation for agreement applied once per review

-- Thinking level (Sep 10): the reasoning effort the agent declared (X-Effort or a marker in X-Model); tier 1 needs a top level.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_type TEXT;   -- type of the session's latest assignment (tier-1 alternation, Sep 11); a release keeps it
ALTER TABLE returns  ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE reviews  ADD COLUMN IF NOT EXISTS effort TEXT;

-- Hot-path indexes (availability review, Sep 10): each of these was a sequential scan on every /start, /result or board view.
CREATE INDEX IF NOT EXISTS jobs_assigned_session_idx ON jobs (problem_id, assigned_session) WHERE status = 'assigned';
CREATE INDEX IF NOT EXISTS jobs_assigned_expiry_idx ON jobs (problem_id, status, expires_at);
CREATE INDEX IF NOT EXISTS jobs_parent_return_idx ON jobs (parent_return_id);
CREATE INDEX IF NOT EXISTS returns_user_created_idx ON returns (user_id, created_at);
CREATE INDEX IF NOT EXISTS returns_problem_status_idx ON returns (problem_id, status, created_at);
CREATE INDEX IF NOT EXISTS messages_user_created_idx ON messages (user_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_problem_seen_idx ON sessions (problem_id, last_seen);

-- Audit returns can route corrections to other documents (agent feedback, Sep 10): [{path, note}], shown on those documents once the audit is accepted.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS also_fix JSONB;
-- Registration from the instruction URL (Chris, Sep 12 2026): a session's length is wall clock from registration (4h, 2h) or an
-- assignment cap or open-ended; registered_via says whether the session came from the query string ('url') or a posted body ('body').
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS registered_via TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS effort_evidence TEXT;   -- the level read from the session's own transcript (Claude Code); wins over the declared X-Effort
-- A transcript that was not a session log can be resubmitted by its author (Chris, Sep 12 2026); the record says when.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS transcript_resubmitted_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS transcript_resubmitted_at TIMESTAMPTZ;
-- Unrecognised harness logs (Chris, Sep 12 2026): a transcript that is JSON lines no known harness writes is accepted, and the shape is
-- recorded once here so a person can add support; the agent is told its system is not supported yet and the report number.
CREATE TABLE IF NOT EXISTS harness_reports (
  id BIGSERIAL PRIMARY KEY,
  signature TEXT UNIQUE NOT NULL,          -- sorted top-level keys of the first JSON lines
  head TEXT NOT NULL,                      -- the first lines, truncated (already through the scrub gates)
  first_return_id BIGINT,
  first_review_id BIGINT,
  user_id BIGINT REFERENCES users(id),
  model TEXT,
  count INT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  note TEXT
);

-- A usage entry counts once per person (Chris, Sep 12 2026: "clean up the highscore"): the same session log sent on two returns, or a
-- superset of an earlier one, credited its tokens twice (bjj 169/170, natepac 105/107). Every counted entry's key is recorded here at
-- intake; an entry already on record for the handle is skipped and the reply says so. The backfill rebuilds the table from scratch.
CREATE TABLE IF NOT EXISTS counted_entries (
  user_id     BIGINT NOT NULL REFERENCES users(id),
  key         TEXT NOT NULL,                 -- cc:<message id> | oc:<message id> | l:<sha1 of the line> for logs whose entries carry no id
  source_type TEXT NOT NULL,                 -- return | review
  source_id   BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS counted_entries_source_idx ON counted_entries (source_type, source_id);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS file_notes JSONB;   -- [{sha, name, notes[]}]: attached files that will not run or reproduce as shipped (never refused; the reviewer is told)

-- Scheduler v2: the session remains the agent. Declared access is never inherited from another session.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS launch_key TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS contact_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_launch_idx ON sessions (problem_id, user_id, launch_key) WHERE launch_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_contact_idx ON sessions (contact_id) WHERE contact_id IS NOT NULL;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS discovery_share NUMERIC CHECK (discovery_share >= 0 AND discovery_share <= 1);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work', 'discovery'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_tools TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_sources TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS preferred_skills TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS origin_key TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempt_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ask_id BIGINT REFERENCES asks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS jobs_ready_project_idx ON jobs (problem_id, purpose, created_at, id) WHERE status = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_open_origin_idx ON jobs (problem_id, origin_key) WHERE origin_key IS NOT NULL AND status IN ('queued','assigned');
CREATE TABLE IF NOT EXISTS assignment_attempts (
  id TEXT PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  session_id TEXT,
  user_id BIGINT NOT NULL,
  model TEXT,
  tier INTEGER,
  purpose TEXT NOT NULL DEFAULT 'work',
  scheduled BOOLEAN NOT NULL DEFAULT true,
  budget_hours NUMERIC NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'assigned',
  reason JSONB NOT NULL DEFAULT '{}',
  request_hash TEXT,
  receipt JSONB
);
-- Preserve old assignments and their history. The pre-v2 race could leave one session holding several jobs.
INSERT INTO assignment_attempts (id, job_id, problem_id, session_id, user_id, model, budget_hours, started_at, status)
SELECT md5('legacy-job:' || j.id::text || ':' || coalesce(j.assigned_at::text,'')), j.id, j.problem_id,
       j.assigned_session, j.assigned_to, s.model, LEAST(j.budget_hours, coalesce((s.ai->>'max_hours_per_assignment')::numeric, 2)), coalesce(j.assigned_at, now()), 'assigned'
FROM jobs j LEFT JOIN sessions s ON s.id = j.assigned_session
WHERE j.status = 'assigned' AND j.assigned_to IS NOT NULL AND j.attempt_id IS NULL
ON CONFLICT DO NOTHING;
UPDATE jobs j SET attempt_id = a.id FROM assignment_attempts a WHERE a.job_id = j.id AND j.status = 'assigned' AND j.attempt_id IS NULL AND a.status = 'assigned';
WITH duplicates AS (
  SELECT id, row_number() OVER (PARTITION BY assigned_session ORDER BY assigned_at, id) AS n
  FROM jobs WHERE status = 'assigned' AND assigned_session IS NOT NULL
)
UPDATE jobs SET status = 'queued', last_released_session = assigned_session, assigned_session = NULL,
  assigned_to = NULL, assigned_at = NULL, expires_at = NULL, release_count = release_count + 1,
  last_release_note = 'scheduler migration: extra concurrent assignment returned to queue'
WHERE id IN (SELECT id FROM duplicates WHERE n > 1);
UPDATE assignment_attempts a SET status = 'released', ended_at = now()
FROM jobs j WHERE j.id = a.job_id AND j.attempt_id = a.id AND j.status <> 'assigned' AND a.status = 'assigned';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_per_session_idx ON jobs (assigned_session) WHERE status = 'assigned' AND assigned_session IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_per_session_idx ON assignment_attempts (session_id) WHERE status = 'assigned' AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attempts_allocation_idx ON assignment_attempts (problem_id, tier, started_at);
CREATE OR REPLACE FUNCTION close_assignment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'assigned' AND NEW.status <> 'assigned' THEN
    UPDATE assignment_attempts SET status = CASE WHEN NEW.status = 'queued' THEN 'released' WHEN NEW.status = 'returned' THEN 'completed' ELSE 'cancelled' END,
      ended_at = now() WHERE id = OLD.attempt_id AND status = 'assigned';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS jobs_close_attempt ON jobs;
CREATE TRIGGER jobs_close_attempt AFTER UPDATE OF status ON jobs FOR EACH ROW EXECUTE FUNCTION close_assignment_attempt();

-- Exact research contacts supplement handle/human asks; their public IDs are not session credentials.
ALTER TABLE asks ADD COLUMN IF NOT EXISTS from_session TEXT;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS to_contact TEXT;
CREATE INDEX IF NOT EXISTS asks_contact_idx ON asks (problem_id, to_contact) WHERE status = 'open';
ALTER TABLE assignment_attempts ADD COLUMN IF NOT EXISTS assignment_payload JSONB;
-- Committed publication effects survive a process crash and are replayed before startup/after mutations.
CREATE TABLE IF NOT EXISTS pending_file_effects (id BIGSERIAL PRIMARY KEY, path TEXT NOT NULL, content TEXT);
-- Routine publication/verification cannot be counted toward the discovery reserve.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_discovery_type_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_discovery_type_check CHECK (purpose <> 'discovery' OR type IN ('explore','direction','break','measure','formalize','source'));
  END IF;
END $$;

-- The server's observation of each published portfolio edition. Source dates are evidence supplied
-- by the repository; recorded_at is our clock. Rows are appended, never rewritten on a re-import.
CREATE TABLE IF NOT EXISTS document_publications (
  id BIGSERIAL PRIMARY KEY,
  problem_id BIGINT NOT NULL REFERENCES problems(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  prepared_at TIMESTAMPTZ,
  source JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS document_publications_path_idx ON document_publications (problem_id, path, id);
-- Research-first process (maintainer, Sep 14). Investment decisions remain separate from trusted claim decisions.
CREATE TABLE IF NOT EXISTS research_routes (
  id BIGSERIAL PRIMARY KEY,
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  lane_id BIGINT REFERENCES lanes(id) ON DELETE SET NULL,
  origin_return_id BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  parent_route_id BIGINT REFERENCES research_routes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  contribution_md TEXT NOT NULL,
  prior_art_md TEXT NOT NULL,
  uncertainty_md TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','active','blocked','paused','known','result')),
  next_step JSONB,
  obstacle JSONB,
  revision INTEGER NOT NULL DEFAULT 1,
  last_return_id BIGINT REFERENCES returns(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE research_routes DROP CONSTRAINT IF EXISTS research_routes_state_check;
ALTER TABLE research_routes ADD CONSTRAINT research_routes_state_check CHECK (state IN ('proposed','active','blocked','paused','known','result'));
CREATE TABLE IF NOT EXISTS research_events (
  id BIGSERIAL PRIMARY KEY,
  route_id BIGINT NOT NULL REFERENCES research_routes(id) ON DELETE CASCADE,
  return_id BIGINT REFERENCES returns(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  evidence_md TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_dependencies (
  route_id BIGINT NOT NULL REFERENCES research_routes(id) ON DELETE CASCADE,
  return_id BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  PRIMARY KEY (route_id, return_id)
);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS research JSONB;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS research_route_id BIGINT REFERENCES research_routes(id) ON DELETE SET NULL;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS verification_plan JSONB;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS verification_fingerprint TEXT;
CREATE INDEX IF NOT EXISTS returns_verification_fingerprint_idx ON returns (problem_id, verification_fingerprint) WHERE verification_fingerprint IS NOT NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS research_route_id BIGINT REFERENCES research_routes(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS research_stage TEXT CHECK (research_stage IN ('discover','triage','pursue','rescue','consolidate'));
-- Generated rescue is exploratory work for any capable tier; keep held/custom jobs intact.
UPDATE jobs SET min_tier=99 WHERE research_stage='rescue' AND type='explore' AND status='queued' AND min_tier=1
  AND (origin_key LIKE 'rescue:%' OR origin_key LIKE 'rescue-sample:%');
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS research_source_return_id BIGINT REFERENCES returns(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS avoid_model TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS evidence_return_id BIGINT REFERENCES returns(id) ON DELETE CASCADE;
ALTER TABLE assignment_attempts ADD COLUMN IF NOT EXISTS research_stage TEXT;
CREATE TABLE IF NOT EXISTS verification_runs (
  id BIGSERIAL PRIMARY KEY,
  subject_return_id BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  result_return_id BIGINT NOT NULL UNIQUE REFERENCES returns(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail','unable')),
  observed TEXT NOT NULL,
  elapsed_seconds NUMERIC NOT NULL CHECK (elapsed_seconds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_runs_fingerprint_idx ON verification_runs (fingerprint);
ALTER TABLE problems ADD COLUMN IF NOT EXISTS research_allocation JSONB;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verification_receipt_id BIGINT REFERENCES verification_runs(id) ON DELETE SET NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verification_sufficiency_md TEXT;
ALTER TABLE verification_runs ADD COLUMN IF NOT EXISTS details JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS research_revision INTEGER;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verification_conflict_through BIGINT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verification_conflict_resolution_md TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_route_investigation_idx ON jobs (research_route_id) WHERE research_route_id IS NOT NULL AND research_stage IN ('triage','pursue','rescue') AND status IN ('queued','assigned');
CREATE INDEX IF NOT EXISTS jobs_research_source_idx ON jobs (research_source_return_id) WHERE research_source_return_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS returns_job_idx ON returns (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS research_dependencies_return_idx ON research_dependencies (return_id);
-- Preserve declared premises on the result that used them, even after its route is rescued.
CREATE TABLE IF NOT EXISTS return_dependencies (
  return_id BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  depends_on_id BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  PRIMARY KEY (return_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS return_dependencies_source_idx ON return_dependencies (depends_on_id);
CREATE INDEX IF NOT EXISTS research_events_route_idx ON research_events (route_id,id);
-- Recover only declared, recorded premises and their documented inheritance; no mathematical inference.
INSERT INTO return_dependencies (return_id,depends_on_id)
  SELECT r.id,source.id FROM returns r
  CROSS JOIN LATERAL (SELECT e.detail->'depends_on' AS premises FROM research_events e
    WHERE e.route_id=r.research_route_id AND e.return_id<=r.id AND e.outcome<>'stale_progress'
      AND jsonb_typeof(e.detail->'depends_on')='array' ORDER BY e.id DESC LIMIT 1) declared
  CROSS JOIN LATERAL jsonb_array_elements_text(declared.premises) dep(value)
  JOIN returns source ON source.id::text=dep.value AND source.problem_id=r.problem_id
  WHERE NOT EXISTS (SELECT 1 FROM research_events e WHERE e.return_id=r.id AND e.outcome='stale_progress')
  ON CONFLICT DO NOTHING;
INSERT INTO return_dependencies (return_id,depends_on_id)
  SELECT rr.last_return_id,d.return_id FROM research_dependencies d JOIN research_routes rr ON rr.id=d.route_id
  WHERE rr.last_return_id IS NOT NULL ON CONFLICT DO NOTHING;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS check_wait_expired_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS reviews_receipt_idx ON reviews (verification_receipt_id) WHERE verification_receipt_id IS NOT NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS needs_reassessment BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS review_history (
  id BIGSERIAL PRIMARY KEY,
  return_id BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  review JSONB NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_history_return_idx ON review_history (return_id);

-- A pending claim can wait for admission without disappearing from the queue.
-- Record when validation entered the queue, including execution packages, and
-- preserve existing work on upgrade. Daily admission limits were retired Sep 14.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS review_admitted_at TIMESTAMPTZ;
UPDATE returns r SET review_admitted_at=admitted.at FROM (
  SELECT id,min(at) AS at FROM (
    SELECT parent_return_id AS id,created_at AS at FROM jobs WHERE type='review'
    UNION ALL SELECT evidence_return_id,created_at FROM jobs WHERE type='check'
    UNION ALL SELECT return_id,created_at FROM reviews
    UNION ALL SELECT return_id,archived_at FROM review_history
  ) events WHERE id IS NOT NULL GROUP BY id
) admitted WHERE r.id=admitted.id AND r.review_admitted_at IS NULL;
CREATE INDEX IF NOT EXISTS returns_review_admission_idx ON returns (user_id,review_admitted_at) WHERE review_admitted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS returns_deferred_review_idx ON returns (problem_id,created_at,id)
  WHERE status='pending' AND review_admitted_at IS NULL AND duplicate_of IS NULL AND NOT provisional;

-- Folder departments (Sep 15). Account credentials, local knowledge, run identity,
-- research direction and execution authority have independent lifetimes.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
CREATE TABLE IF NOT EXISTS browser_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_account_id TEXT;
UPDATE users SET agent_account_id=md5(random()::text || clock_timestamp()::text || id::text) WHERE agent_account_id IS NULL;
ALTER TABLE users ALTER COLUMN agent_account_id SET DEFAULT md5(random()::text || clock_timestamp()::text);
CREATE UNIQUE INDEX IF NOT EXISTS users_agent_account_idx ON users(agent_account_id);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id,registration_key)
);
CREATE TABLE IF NOT EXISTS agent_directions (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','complete','blocked','paused','refuted')),
  note TEXT NOT NULL DEFAULT '',
  continued_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_direction_revisions (
  direction_id TEXT NOT NULL REFERENCES agent_directions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  words TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(direction_id,revision)
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS department_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS direction_id TEXT REFERENCES agent_directions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_run_idx ON sessions(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_department_idx ON sessions(department_id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS agent_direction_id TEXT REFERENCES agent_directions(id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS agent_direction_revision INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_agent_step_idx ON jobs(agent_direction_id) WHERE agent_direction_id IS NOT NULL AND status IN ('queued','assigned');
ALTER TABLE assignment_attempts ADD COLUMN IF NOT EXISTS department_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE assignment_attempts ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE assignment_attempts ADD COLUMN IF NOT EXISTS direction_snapshot JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS department_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS department_id TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS department_id TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS from_department TEXT;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS from_run TEXT;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS to_department TEXT;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS to_run TEXT;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS handoff TEXT NOT NULL DEFAULT 'department' CHECK(handoff IN ('department','none'));
ALTER TABLE asks ADD COLUMN IF NOT EXISTS routing TEXT CHECK(routing IN ('account','department','run','human','anyone'));
ALTER TABLE asks ADD COLUMN IF NOT EXISTS claimed_session TEXT;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS claim_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asks ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ;
-- Events are enqueued under the same project lock as publication. Receipt IDs are
-- opaque per-event values: acknowledgements cannot skip unseen transactions.
CREATE TABLE IF NOT EXISTS department_deliveries (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(department_id,message_id)
);
CREATE INDEX IF NOT EXISTS department_pending_idx ON department_deliveries(department_id,problem_id,created_at) WHERE acknowledged_at IS NULL;
CREATE TABLE IF NOT EXISTS mutation_receipts (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,session_id,request_id)
);
-- Derive public provenance from authenticated session/attempt ownership, never
-- from a submitted display label. Old records retain unknown provenance.
CREATE OR REPLACE FUNCTION department_provenance() RETURNS trigger AS $$
DECLARE s sessions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='messages' THEN SELECT * INTO s FROM sessions WHERE id=coalesce(NEW.session,nullif(current_setting('solveathome.session',true),'')) AND user_id=NEW.user_id;
  ELSIF TG_TABLE_NAME='reviews' THEN SELECT ss.* INTO s FROM sessions ss JOIN jobs j ON j.assigned_session=ss.id WHERE j.id=NEW.review_job_id AND ss.user_id=NEW.user_id;
  ELSIF NEW.job_id IS NOT NULL THEN SELECT ss.* INTO s FROM sessions ss JOIN jobs j ON j.assigned_session=ss.id WHERE j.id=NEW.job_id AND ss.user_id=NEW.user_id;
  END IF;
  IF s.id IS NULL THEN SELECT * INTO s FROM sessions WHERE id=nullif(current_setting('solveathome.session',true),'') AND user_id=NEW.user_id; END IF;
  NEW.department_id=s.department_id; NEW.run_id=s.run_id;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS messages_department_provenance ON messages;
CREATE TRIGGER messages_department_provenance BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION department_provenance();
DROP TRIGGER IF EXISTS returns_department_provenance ON returns;
CREATE TRIGGER returns_department_provenance BEFORE INSERT ON returns FOR EACH ROW EXECUTE FUNCTION department_provenance();

DROP TRIGGER IF EXISTS reviews_department_provenance ON reviews;
CREATE TRIGGER reviews_department_provenance BEFORE INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION department_provenance();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_direction_idx ON sessions(direction_id) WHERE direction_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_direction_links (
  direction_id TEXT NOT NULL REFERENCES agent_directions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  PRIMARY KEY(direction_id,revision,job_id)
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recovery_attempt_id TEXT;
CREATE TABLE IF NOT EXISTS assignment_recoveries (
  old_attempt_id TEXT PRIMARY KEY REFERENCES assignment_attempts(id) ON DELETE CASCADE,
  new_attempt_id TEXT NOT NULL UNIQUE REFERENCES assignment_attempts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Keep the permanent-token contract during a rolling deployment: an older slot
-- must not revoke every agent when the person signs in again.
CREATE OR REPLACE FUNCTION protect_agent_token() RETURNS trigger AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash OR
     (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND current_setting('solveathome.invalidate_token',true) IS DISTINCT FROM 'user-explicit') THEN
    RAISE EXCEPTION 'agent tokens change only after explicit user invalidation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tokens_explicit_invalidation ON tokens;
CREATE TRIGGER tokens_explicit_invalidation BEFORE UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION protect_agent_token();
CREATE TABLE IF NOT EXISTS run_channel_members (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  last_seen_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id,session_id)
);

-- Standard review guidance is versioned (Sep 16 2026): a queued review from an earlier version is refreshed when served.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS brief_version INTEGER;

-- Display names (Sep 17 2026): users.display_name (above) is set by the person on /settings. This log carries the rate limit
-- (3 'set' rows by the person in 30 days), an owner's removal and lock, and the audit trail. It never holds the name itself,
-- so clearing users.display_name leaves nothing behind. Additive only: the old slot never reads it.
CREATE TABLE IF NOT EXISTS display_name_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('set','clear','remove','lock','unlock')),
  by_user_id  BIGINT REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS display_name_events_user ON display_name_events (user_id, id);

-- Review triage (Chris, Sep 18 2026, #sah-review-only-meaningful: "let a tier 2 agent do a first review to see if it's worth escalating").
-- One row per triage answer: whether a trusted verdict on the return would change the record. An investment decision, never a truth grade.
CREATE TABLE IF NOT EXISTS triages (
  id            BIGSERIAL PRIMARY KEY,
  return_id     BIGINT NOT NULL REFERENCES returns(id),
  triage_job_id BIGINT NOT NULL REFERENCES jobs(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  effort        TEXT,
  escalate      BOOLEAN NOT NULL,                -- true: the return goes before trusted reviewers; false: recorded as it stands
  notes_md      TEXT NOT NULL DEFAULT '',
  transcript    TEXT NOT NULL DEFAULT '',
  tokens        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (return_id, user_id)
);
CREATE INDEX IF NOT EXISTS triages_return_idx ON triages (return_id, id);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS triage_lead BIGINT;   -- covered by a triage of this lead return: one trusted review decides the series (Chris, Sep 19 2026)
ALTER TABLE triages ADD COLUMN IF NOT EXISTS reason TEXT;              -- on a no: false | uninteresting | known | duplicate

-- Opus 5.5 is tier 1 at high, xhigh or max (Chris, Sep 22 2026): lift a row that registered itself from the old opus default. A row someone set by hand is left alone.
UPDATE model_tiers SET tier = 1, note = 'auto: frontier anthropic model (Opus 5.5 tier 1 from Sep 22 2026)', updated_at = now()
  WHERE model IN ('claude-opus-5-5', 'claude-opus-5.5') AND tier > 1 AND note LIKE 'auto:%' AND note NOT LIKE '%frontier%';

-- Review follows the served text (Sep 24 2026, paper review integrity): an accepted correction was integrated and then replaced by an
-- older mirror cut while the paper kept its "reviewed" label, and a required correction lived only in a review's also_fix.
-- A revision records the text it was made against; integration records what became of it; a correction is a finding with a lifecycle.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS revision_base_sha TEXT;   -- sha256 of the document text the revision edits, taken at submission; NULL on older returns (unknown)
ALTER TABLE returns ADD COLUMN IF NOT EXISTS integration TEXT;         -- applied | unchanged | conflict | missing: what integrating the accepted revision did
ALTER TABLE returns ADD COLUMN IF NOT EXISTS resolves JSONB;           -- finding ids a repair return says it addresses (default: the findings its job carried when it was taken)
CREATE TABLE IF NOT EXISTS findings (
  id          BIGSERIAL PRIMARY KEY,
  problem_id  BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,                                   -- the document to correct
  content_sha TEXT,                                            -- the text the finding was made against (NULL: recorded before findings were tracked)
  return_id   BIGINT REFERENCES returns(id) ON DELETE CASCADE, -- the return under review, or the accepted audit that routed it
  review_id   BIGINT REFERENCES reviews(id) ON DELETE SET NULL,-- the trusted review that made it, if one did
  note        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'unspecified',             -- before_circulation | advisory | unspecified
  status      TEXT NOT NULL DEFAULT 'open',                    -- open | resolved
  job_id      BIGINT REFERENCES jobs(id) ON DELETE SET NULL,   -- the fix job carrying it now
  linked_at   TIMESTAMPTZ,                                     -- when it was put on that job
  resolved_by_return_id BIGINT REFERENCES returns(id) ON DELETE SET NULL,
  resolved_sha TEXT,                                           -- the text on which it was resolved
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS findings_origin ON findings (COALESCE(return_id, 0), path, md5(note));
CREATE INDEX IF NOT EXISTS findings_open ON findings (problem_id, path) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS finding_events (
  id          BIGSERIAL PRIMARY KEY,
  finding_id  BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,                                   -- the state it moved to
  note        TEXT NOT NULL DEFAULT '',
  return_id   BIGINT REFERENCES returns(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Corrections recorded before findings existed: a trusted reviewer's also_fix and an accepted audit's also_fix become open findings of
-- unknown text, preserving explicit optional/required scope. Nothing is presumed fixed; an agent or a reviewer closes them.
INSERT INTO findings (problem_id, path, return_id, review_id, note, scope, created_at)
  SELECT r.problem_id, x->>'path', r.id, rv.id, x->>'note', CASE WHEN x->>'scope' IN ('advisory','before_circulation') THEN x->>'scope' ELSE 'unspecified' END, rv.created_at FROM reviews rv JOIN returns r ON r.id = rv.return_id, jsonb_array_elements(rv.also_fix) x
  WHERE rv.trusted AND jsonb_typeof(rv.also_fix) = 'array' AND coalesce(x->>'path', '') <> '' AND coalesce(x->>'note', '') <> ''
  ON CONFLICT (COALESCE(return_id, 0), path, md5(note)) DO NOTHING;
INSERT INTO findings (problem_id, path, return_id, note, scope, created_at)
  SELECT r.problem_id, x->>'path', r.id, x->>'note', CASE WHEN x->>'scope' IN ('advisory','before_circulation') THEN x->>'scope' ELSE 'unspecified' END, r.created_at FROM returns r, jsonb_array_elements(r.also_fix) x
  WHERE r.type = 'audit' AND r.status = 'accepted' AND NOT r.provisional AND jsonb_typeof(r.also_fix) = 'array' AND coalesce(x->>'path', '') <> '' AND coalesce(x->>'note', '') <> ''
  ON CONFLICT (COALESCE(return_id, 0), path, md5(note)) DO NOTHING;
-- The first step on a new route is a first look, not a triage (Chris, Sep 25 2026, #sah-route-triage-title: "If this was not a triage task, it
-- should not show up as such"). Triage is the review bookkeeping job only. The check keeps 'triage' for the previous container during a
-- deploy; every start relabels what it wrote, and a queued brief says first look.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_research_stage_check' AND pg_get_constraintdef(oid) LIKE '%first_look%') THEN
    ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_research_stage_check;
    ALTER TABLE jobs ADD CONSTRAINT jobs_research_stage_check CHECK (research_stage IN ('discover','first_look','triage','pursue','rescue','consolidate'));
  END IF;
END $$;
UPDATE jobs SET research_stage = 'first_look' WHERE research_stage = 'triage';
UPDATE assignment_attempts SET research_stage = 'first_look' WHERE research_stage = 'triage';
UPDATE jobs SET brief_md = replace(brief_md, 'do not reproduce them in triage.', 'do not reproduce them in a first look.') WHERE research_stage = 'first_look' AND status = 'queued' AND brief_md LIKE '%do not reproduce them in triage.%';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_route_first_look_idx ON jobs (research_route_id) WHERE research_route_id IS NOT NULL AND research_stage IN ('first_look','pursue','rescue') AND status IN ('queued','assigned');
-- No "<type>: " in a title (Chris, Sep 25 2026, #sah-route-triage-title: "We don't want our tiles to have <type>: Text. We can add a type
-- data to an entry and then render a label"). The type, the route stage and the follow-up are columns and render as a badge (jobLabel).
-- A job made for one session was known by its title prefix; it gets its marker first. Then one rule takes off a prefix that names the
-- job's own type (a paper's or an audit's included), route stage, lead hunt or follow-up, and keeps the title as written in title_before: a row is rewritten once, and a
-- title the previous container writes during a deploy is taken at the next start.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title_before TEXT;
UPDATE jobs SET origin_key = 'tangent:legacy:' || id WHERE origin_key IS NULL AND parent_return_id IS NULL AND ((type = 'challenge' AND title LIKE 'Challenge: %') OR (type = 'direction' AND title LIKE 'Direction: %'));
UPDATE jobs SET origin_key = 'open-questions:legacy:' || id WHERE origin_key IS NULL AND type = 'explore' AND title LIKE 'Explore: open questions%';
UPDATE jobs j SET title_before = j.title, title = x.t FROM (
    SELECT id, CASE WHEN type IN ('challenge', 'direction') THEN s ELSE upper(left(s, 1)) || substr(s, 2) END AS t FROM (
      SELECT id, type, regexp_replace(regexp_replace(regexp_replace(regexp_replace(title, '^Rescue investigation: return #', 'Reassess return #'),
        '^(Make checkable|Leads): ', ''), '^(Triage|Pursue|Rescue|Paper|Audit): ', ''), '^' || initcap(type) || ': ', '') AS s
      FROM jobs WHERE title_before IS NULL AND type <> 'triage'
        AND (title ~ '^(Leads|Rescue investigation|Make checkable|Triage|Pursue|Rescue|Paper|Audit): ' OR title LIKE initcap(type) || ': %')) a) x
  WHERE j.id = x.id;

-- An accepted direction opens a lane only when it carries the person's words (Chris, Sep 25 2026). The lanes opened before that
-- from route results and reports are closed, never deleted: they stay in /lanes and the dataset, leave the active table and are
-- never picked for work; their channels, which nobody ever posted in, close with them and leave the discussion list.
UPDATE lanes l SET status = 'closed' FROM returns r
  WHERE l.variant = 'direction' AND l.status = 'open' AND l.slug = 'dir-' || r.id AND r.problem_id = l.problem_id AND nullif(btrim(r.human_md), '') IS NULL;
UPDATE channels c SET status = 'closed', closed_note = 'lane closed: a direction without its person''s words opens no lane' FROM lanes l
  WHERE c.lane_id = l.id AND c.path = l.slug AND l.status = 'closed' AND c.status = 'open' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id);

-- Announcements (Chris, Sep 26 2026, #sah-discord-announcer: "only share when there is actually something exciting that happened at the
-- validation state ... the credit is given 100% to the person who found the direction / proof / whatever"). A reviewer holding a role on the
-- project (owner or granted trust, never trust by model) marks an accepted finding as worth announcing; src/lib/announce.ts turns a marked,
-- trusted, non-provisional acceptance of a candidate kind into one outbox row, holds it, and posts it to the project's webhook naming the
-- return's author only. The webhook URL lives in the environment and is never stored.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS announce BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS announce_md TEXT;   -- the validator's one sentence (<= 200 chars): what the finding changes, in the record's words
CREATE TABLE IF NOT EXISTS announcements (
  id                 BIGSERIAL PRIMARY KEY,
  problem_id         BIGINT NOT NULL REFERENCES problems(id),
  return_id          BIGINT NOT NULL REFERENCES returns(id),
  review_id          BIGINT REFERENCES reviews(id),            -- the marking review
  finder_user_id     BIGINT NOT NULL REFERENCES users(id),     -- the return's author: the one person the post credits
  kind               TEXT NOT NULL,                            -- proof | refutation | challenge | verified | opening
  final_rung         TEXT,                                     -- the rung the post states; a later change is a correction
  dedupe_key         TEXT NOT NULL UNIQUE,                     -- accept:<return id>: one post per return, ever
  decided_at         TIMESTAMPTZ NOT NULL,                     -- the trusted acceptance the post is about
  due_at             TIMESTAMPTZ NOT NULL,                     -- decided_at + the project's hold
  status             TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','sent','suppressed','corrected')),
  flag               TEXT,                                     -- what the post left out and why (overclaiming agent text); since Sep 26 2026 no person holds a row for it
  approved_at        TIMESTAMPTZ,
  approved_by        BIGINT REFERENCES users(id),
  suppressed_reason  TEXT,
  payload            JSONB,                                    -- what was sent, as sent
  discord_message_id TEXT,
  sent_at            TIMESTAMPTZ,
  corrected_at       TIMESTAMPTZ,
  correction         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcements_problem_status_idx ON announcements (problem_id, status, due_at);

-- Model identity, continued (review 4163): the tables the own-kind rule and the session check read, canonical like the rest.
-- They run here, after the tables exist. A session registered under a variant spelling keeps working: its stored model now
-- matches the canonical X-Model it sends. No-ops once every row is canonical.
UPDATE sessions            SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE assignment_attempts SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE triages             SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE harness_reports     SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE trust_applications  SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE jobs                SET avoid_model = canon_model(avoid_model) WHERE avoid_model <> canon_model(avoid_model);

-- Stale next steps (#1838, #1845, #1847 on 2026-09-26: three pursuits handed out 7 to 12 days after queueing, each returning
-- "known"). A queued pursuit whose step may already be answered is held and a bounded step check goes out in its place
-- (src/lib/research.ts holdForStepCheck). step_check_of names the held pursuit on the check; step_checked_through is the
-- latest return a check has compared the step against, so the same candidates never trigger a second check.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS step_check_of BIGINT REFERENCES jobs(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS step_checked_through BIGINT;
-- Server comparison notes are evidence to read, not changes to the experiment.
-- Existing appended briefs remain intact; only future comparison notes use this field.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS step_check_notes_md TEXT NOT NULL DEFAULT '';
-- The agent's own session window, declared with X-Session-Ends (#mba-sah-held-feedback-items, item 10): jobs are fitted to the time
-- left (with ends_at, the person's time=); it never ends the session or limits a job.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS declared_end TIMESTAMPTZ;

-- GPT-6.1 Sol is tier 1 at high, xhigh or max like Astra and Opus 5.5 (Chris, Oct 1 2026). The row is named so the board shows it; a row someone set by hand is left alone.
INSERT INTO model_tiers (model, provider, tier, note) VALUES ('gpt-6.1-sol', 'openai', 1, 'tier 1 at high, xhigh or max (Chris, Oct 1 2026)') ON CONFLICT (model) DO NOTHING;

-- Required corrections are Tier 1 trusted work (Oct 2 2026). Existing held attempts keep their instructions; queued repairs,
-- including rebases of accepted changes, use the new eligibility. Additive for the previous container during a release.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requires_trust BOOLEAN NOT NULL DEFAULT false;
-- Scope was omitted by the older backfill. Reconcile from the immutable annotations without reopening resolved work; an explicit
-- before-circulation obligation wins over optional wording. Group origins so repeated review annotations remain idempotent.
WITH annotations AS (
  SELECT r.id AS return_id, x->>'path' AS path, md5(x->>'note') AS note_hash, x->>'scope' AS scope
    FROM reviews rv JOIN returns r ON r.id=rv.return_id, jsonb_array_elements(rv.also_fix) x WHERE rv.trusted
  UNION ALL
  SELECT h.return_id, x->>'path', md5(x->>'note'), x->>'scope'
    FROM review_history h, jsonb_array_elements(CASE WHEN jsonb_typeof(h.review->'also_fix')='array' THEN h.review->'also_fix' ELSE '[]'::jsonb END) x
    WHERE h.review->>'trusted'='true'
  UNION ALL
  SELECT r.id, x->>'path', md5(x->>'note'), x->>'scope'
    FROM returns r, jsonb_array_elements(r.also_fix) x WHERE r.type='audit' AND r.status='accepted' AND NOT r.provisional
), scopes AS (
  SELECT return_id,path,note_hash, CASE WHEN bool_or(scope='before_circulation') THEN 'before_circulation' ELSE 'advisory' END AS scope
    FROM annotations WHERE scope IN ('advisory','before_circulation') GROUP BY return_id,path,note_hash
), changed AS (
  UPDATE findings f SET scope=s.scope FROM scopes s WHERE f.return_id=s.return_id AND f.path=s.path AND md5(f.note)=s.note_hash
    AND (f.scope='unspecified' OR (f.scope='advisory' AND s.scope='before_circulation')) AND f.scope<>s.scope RETURNING f.id,f.status,f.scope
)
INSERT INTO finding_events (finding_id,status,note) SELECT id,status,'annotation scope recovered: ' || scope FROM changed;
-- Failed recovery attempts rotate behind untried findings: unavailable historical paths cannot starve later served corrections.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS last_recovery_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS findings_recovery_idx ON findings (problem_id,last_recovery_at NULLS FIRST,id) WHERE status='open' AND scope<>'advisory';
UPDATE jobs SET min_tier=1, requires_trust=true
  WHERE status='queued' AND type='audit' AND (title LIKE 'Fix %' OR title LIKE 'Rebase return #%'
    OR EXISTS (SELECT 1 FROM findings f WHERE f.job_id=jobs.id AND f.status='open' AND f.scope<>'advisory'))
    AND (min_tier<>1 OR NOT requires_trust);

-- Durable folder-local assignment-fit checkpoints; never research verdicts or global bans.
CREATE TABLE IF NOT EXISTS assignment_deferrals (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES assignment_attempts(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  department_id TEXT,
  model TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('execution','source')),
  job_fingerprint TEXT NOT NULL,
  session_fit JSONB NOT NULL,
  source_epoch JSONB NOT NULL,
  evidence_md TEXT NOT NULL,
  reopen_when TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS assignment_deferrals_job_idx ON assignment_deferrals(job_id,user_id);
-- Old clients and historical checkpoints retain their original conservative fit.
ALTER TABLE assignment_deferrals ADD COLUMN IF NOT EXISTS fit_scope TEXT NOT NULL DEFAULT 'legacy'
  CHECK (fit_scope IN ('legacy','runtime','publication'));
-- Prospective opt-in: preserve every older project-wide epoch and release receipt.
ALTER TABLE assignment_deferrals ADD COLUMN IF NOT EXISTS source_scope TEXT NOT NULL DEFAULT 'project'
  CHECK (source_scope IN ('project','task'));
ALTER TABLE assignment_deferrals ADD COLUMN IF NOT EXISTS source_paths TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE assignment_deferrals ADD COLUMN IF NOT EXISTS task_source_epoch JSONB;
-- Prospective stable task identity; null retains an older checkpoint's exact semantics.
ALTER TABLE assignment_deferrals ADD COLUMN IF NOT EXISTS task_job_fingerprint TEXT;

-- Named interventions hold ordinary scheduling, without transferring attempts or judging science.
CREATE TABLE IF NOT EXISTS job_handoffs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('person','agent')),
  recipient_user_id BIGINT NOT NULL REFERENCES users(id),
  recipient_contact TEXT,
  reason_md TEXT NOT NULL,
  required_access_md TEXT NOT NULL,
  resume_when TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','resolved','cancelled')),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  resolution_md TEXT,
  CHECK ((recipient_kind='agent') = (recipient_contact IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS job_handoffs_waiting_idx ON job_handoffs(job_id) WHERE status='waiting';

CREATE TABLE IF NOT EXISTS job_correction_prerequisites (
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  PRIMARY KEY(job_id,finding_id)
);
ALTER TABLE job_correction_prerequisites ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE job_correction_prerequisites ADD COLUMN IF NOT EXISTS reason_md TEXT;
-- Older prerequisite rows have no recorded chronology; retain unknown provenance.
ALTER TABLE job_correction_prerequisites ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE job_correction_prerequisites ALTER COLUMN created_at SET DEFAULT now();

-- Progress emails (#sah-progress-emails, approved 3 Oct 2026): at most one email per person per day, news only, opt-out per choice.
-- The address is personal data: never in DUMP_TABLES, never served to an agent route, set and read only by the person on the site.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_source TEXT;            -- github_verified | typed
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ; -- NULL: a typed address waiting for its confirmation link; nothing is sent to it
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_status TEXT;            -- NULL (fine) | bounced | complained: nothing is sent until the address changes
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_prompts INT NOT NULL DEFAULT 0;   -- times the email step was shown and passed; asked at most twice
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_prompted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_tz TEXT;                -- IANA zone from the person's browser; NULL = UTC
-- The verified address GitHub offered at sign-in, held on the browser session until the person saves it on the email step (the save is the consent).
ALTER TABLE browser_sessions ADD COLUMN IF NOT EXISTS github_email TEXT;
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  updates    TEXT NOT NULL DEFAULT 'daily' CHECK (updates IN ('daily','weekly','off')),
  newsletter BOOLEAN NOT NULL DEFAULT false,
  projects   BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Append-only proof of consent: who chose what, when, from which screen, under which wording.
CREATE TABLE IF NOT EXISTS email_consent_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice          TEXT NOT NULL,           -- address | updates | newsletter | projects
  value           TEXT NOT NULL,
  source          TEXT NOT NULL,           -- welcome | settings | unsubscribe | webhook | confirm
  wording_version TEXT NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_consent_user_idx ON email_consent_events (user_id, id);
-- What happened to a person's work, queued for their next email. Facts only (ids and numbers); the text is written at send time.
CREATE TABLE IF NOT EXISTS email_items (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id  BIGINT REFERENCES problems(id),
  kind        TEXT NOT NULL,
  score       INTEGER NOT NULL,
  news        BOOLEAN NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  facts       JSONB NOT NULL DEFAULT '{}',
  happened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_id    BIGINT                       -- the outbox row that reported it; NULL = still waiting
);
CREATE INDEX IF NOT EXISTS email_items_waiting_idx ON email_items (user_id) WHERE email_id IS NULL;
-- One row per person per local day, never more: the unique key is the one-a-day cap (Chris, 3 Oct 2026: "absolutely limited to one email per day").
CREATE TABLE IF NOT EXISTS email_outbox (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_day           DATE NOT NULL,
  edition             TEXT NOT NULL,       -- daily | weekly | letter
  subject             TEXT NOT NULL DEFAULT '',
  sections            JSONB NOT NULL DEFAULT '{}',   -- lead, items, stats snapshot (the next email's rank comparison reads it)
  status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','suppressed','failed')),
  suppressed_reason   TEXT,
  provider_message_id TEXT,
  holdout             BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  first_click_at      TIMESTAMPTZ,
  UNIQUE (user_id, local_day)
);
-- The monthly letter and new-project news: drafted, approved by an owner, then folded into each opted-in person's next email.
CREATE TABLE IF NOT EXISTS email_letters (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('letter','project')),
  subject     TEXT NOT NULL,
  body_md     TEXT NOT NULL,
  created_by  BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat contributions over MCP (#sah-mcp-real-work-build, Chris, Oct 4 2026: "allowing people using ChatGPT and not Codex would be amazing").
-- solveathome.org is its own OAuth 2.1 authorization server for its MCP endpoint (src/lib/oauth.ts). These tables hold credentials and are
-- never exported in the public dump. Tokens are opaque and stored as SHA-256 hashes only; nothing here touches the agent token (tokens).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,                 -- an https URL (Client ID Metadata Document) or an id we issued (dynamic registration)
  kind           TEXT NOT NULL CHECK (kind IN ('cimd','dcr')),
  client_name    TEXT NOT NULL DEFAULT '',
  redirect_uris  JSONB NOT NULL DEFAULT '[]',
  secret_hash    TEXT,                             -- dynamic registration with client_secret_post/basic only
  auth_method    TEXT NOT NULL DEFAULT 'none',
  host           TEXT NOT NULL DEFAULT 'other',    -- chatgpt | claude | other: the chat app, which names the session's model label
  metadata       JSONB NOT NULL DEFAULT '{}',
  registered_ip  TEXT,
  fetched_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS oauth_requests (       -- an authorization request waiting for the person's consent (ten minutes)
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  state          TEXT,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  csrf           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_grants (         -- one person's connection of one chat app; revoked only by the person (Disconnect) or a refresh-token replay
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  terms_version  TEXT NOT NULL,                    -- the terms the person accepted on the consent page
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoke_note    TEXT
);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  grant_id       BIGINT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash     TEXT PRIMARY KEY,
  grant_id       BIGINT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at        TIMESTAMPTZ,                      -- a refresh token is used once; a second use revokes the grant
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
-- What the server saw of a chat session: every tool call and its answer. A chat app keeps no session log the server can read, so this is the
-- transcript of a chat return (kind mcp-observed); its usage is unmeasured and never estimated.
CREATE TABLE IF NOT EXISTS mcp_calls (
  id               BIGSERIAL PRIMARY KEY,
  grant_id         BIGINT REFERENCES oauth_grants(id) ON DELETE SET NULL,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       TEXT,
  tool             TEXT NOT NULL,
  args             JSONB NOT NULL DEFAULT '{}',
  result_text      TEXT NOT NULL DEFAULT '',
  is_error         BOOLEAN NOT NULL DEFAULT false,
  protocol_version TEXT,
  client           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_calls_session_idx ON mcp_calls (session_id, id);
CREATE INDEX IF NOT EXISTS mcp_calls_grant_idx ON mcp_calls (grant_id, created_at);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS oauth_grant_id BIGINT;
-- A chat app does not say which model ran, and the person can switch models mid-chat: chat sessions carry these labels, never a model id.
-- Tier 3: they contribute and do not judge (no triage, no review), and every return goes to a trusted reviewer.
INSERT INTO model_tiers (model, provider, tier, note) VALUES
  ('chatgpt-unmeasured', 'openai', 3, 'ChatGPT over MCP: the model is not measured (Oct 4 2026)'),
  ('claude-chat-unmeasured', 'anthropic', 3, 'Claude app over MCP: the model is not measured (Oct 4 2026)'),
  ('mcp-unmeasured', 'unknown', 3, 'another chat app over MCP: the model is not measured (Oct 4 2026)')
ON CONFLICT (model) DO NOTHING;
-- Every acceptance of the terms, by version (Chris, Oct 4 2026: "record the accepted version for each user so we can always tell who is on
-- which"). users.terms_version stays the current one; this keeps the history, and how it was given: on the site or on a chat app's consent page.
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  via         TEXT NOT NULL CHECK (via IN ('site','oauth','backfill')),
  client_id   TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terms_acceptances_user_idx ON terms_acceptances (user_id, accepted_at DESC);
INSERT INTO terms_acceptances (user_id, version, via, accepted_at)
  SELECT u.id, u.terms_version, 'backfill', coalesce(u.terms_accepted_at, u.created_at) FROM users u
  WHERE u.terms_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM terms_acceptances a WHERE a.user_id = u.id);

-- Explicit, hash-bound statement/definition review; proof execution stays on donors.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS lean_statement_review jsonb;
-- A portable execution contract needs its own independent source review; it is not a statement attestation.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS lean_execution_review jsonb;

-- Preserve reported identities; aliases cannot manufacture independent Lean validators/reviewers.
CREATE OR REPLACE FUNCTION lean_model_identity(model text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(canon_model(model), '(-(none|minimal|low|medium|high|xhigh|max|maximum|extended|extra-high|extrahigh|x_high|ultra|deep|off))+$', ''), '([0-9])\.(?=[0-9])', '\1-', 'g');
$$;
-- Lean independence (Chris, Oct 6 2026: "Different model I think we should keep but it can be same user for approved users and tier 1 models").
-- Statement and mathematical correctness review require a distinct model family and Tier 1/high.
-- Its user differs or is approved on the project (owner or trusted by grant, or the researcher).
-- The maintainer handles of OWNER_HANDLES are known to the scheduler's session check, not here. Non-Lean packages keep their rules.
CREATE OR REPLACE FUNCTION lean_approved_member(p_problem bigint, p_user bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM project_roles WHERE problem_id=p_problem AND user_id=p_user AND revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM problems WHERE id=p_problem AND researcher_user_id=p_user);
$$;
CREATE OR REPLACE FUNCTION lean_tier1(p_model text, p_effort text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(lower(p_effort) IN ('high','xhigh','max'), false) AND EXISTS (SELECT 1 FROM model_tiers WHERE model=canon_model(p_model) AND tier=1);
$$;
-- Model versions and sibling models do not supply a second proof-review family.
CREATE OR REPLACE FUNCTION lean_model_family(model text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lean_model_identity(model) ~ '^(claude-(opus|sonnet|haiku|fable|mythos)(-|$)|(fable|mythos)(-|$))' THEN 'anthropic'
    WHEN lean_model_identity(model) ~ '^(gpt-[0-9]|o[0-9](-|$)|astra(-|$))' THEN 'openai'
    WHEN lean_model_identity(model) ~ '^(gemini|gemma|palm)(-|$)' THEN 'google'
    WHEN lean_model_identity(model) ~ '^llama(-|$)' THEN 'meta'
    WHEN lean_model_identity(model) ~ '^(mistral|mixtral|codestral|magistral)(-|$)' THEN 'mistral'
    WHEN lean_model_identity(model) ~ '^deepseek(-|$)' THEN 'deepseek'
    WHEN lean_model_identity(model) ~ '^(qwen|qwq)(-|$)' THEN 'alibaba'
    WHEN lean_model_identity(model) ~ '^grok(-|$)' THEN 'xai'
    WHEN lean_model_identity(model) ~ '^(kimi|moonshot)(-|$)' THEN 'moonshot'
    ELSE NULL END;
$$;
CREATE OR REPLACE FUNCTION lean_independent(p_problem bigint, p_actor bigint, p_actor_model text, p_actor_effort text, p_author bigint, p_author_model text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(lean_model_family(p_actor_model)<>lean_model_family(p_author_model), false)
    AND lean_tier1(p_actor_model, p_actor_effort)
    AND (p_actor<>p_author OR lean_approved_member(p_problem, p_actor));
$$;
-- V2 intake normalizes inventories and integer bounds. Compact canonical JSON matches its key-sorted digest
-- without an extension: sha256(bytea) is built in. Strings retain their JSON escaping and arrays their normalized order.
CREATE OR REPLACE FUNCTION lean_identity_canonical(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_json(key)::text||':'||lean_identity_canonical(val),',' ORDER BY key COLLATE "C") FROM jsonb_each(value) AS item(key,val)),'')||'}'
    WHEN 'array' THEN '['||coalesce((SELECT string_agg(lean_identity_canonical(val),',' ORDER BY ordinal) FROM jsonb_array_elements(value) WITH ORDINALITY AS item(val,ordinal)),'')||']'
    ELSE value::text END;
$$;
CREATE OR REPLACE FUNCTION lean_identity_binding(domain text, value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(domain||E'\n'||lean_identity_canonical(value),'UTF8')),'hex');
$$;
-- Scheduling predicate. V1 keeps its original exact profile equality; V2 binds mathematical meaning separately
-- from proof exports and portable execution contracts. Serving also recomputes bindings from the strict parser.
CREATE OR REPLACE FUNCTION lean_statement_review_current(subject_id bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM returns proof JOIN reviews rv ON rv.id::text=proof.verification_plan->'lean'->>'statement_review_id'
      JOIN returns source ON source.id=rv.return_id AND source.problem_id=proof.problem_id
    WHERE proof.id=subject_id AND lean_tier1(proof.model,proof.effort) AND lean_tier1(source.model,source.effort) AND rv.trusted AND rv.verdict='accept' AND NOT rv.needs_reassessment
      AND source.status='accepted' AND NOT source.provisional
      AND lean_independent(proof.problem_id, rv.user_id, rv.model, rv.effort, proof.user_id, proof.model)
      AND lean_independent(proof.problem_id, rv.user_id, rv.model, rv.effort, source.user_id, source.model)
      AND rv.lean_statement_review->>'binding_sha256' ~ '^[a-f0-9]{64}$'
      AND CASE WHEN proof.verification_plan->'lean'->>'policy' IN ('lean-comparator-v2','lean-kernel-v1') THEN
        source.verification_plan->'lean'->>'policy' IN ('lean-comparator-v2','lean-kernel-v1')
        AND jsonb_typeof(proof.verification_plan->'lean'->'scientific_identity')='object'
        AND proof.verification_plan->'lean'->'scientific_identity'->>'schema'='solveathome-lean-scientific-v2'
        AND rv.lean_statement_review->>'binding_sha256'=lean_identity_binding('solveathome-lean-meaning-v2',
          (proof.verification_plan->'lean'->'scientific_identity') - 'proof_artifacts')
        AND ((source.verification_plan->'lean'->'scientific_identity') - 'proof_artifacts')=
            ((proof.verification_plan->'lean'->'scientific_identity') - 'proof_artifacts')
      ELSE source.verification_plan->'lean'->>'policy'='lean-comparator-v1'
        AND proof.verification_plan->'lean'->>'policy'='lean-comparator-v1'
        AND ((source.verification_plan->'lean') - 'statement_review_id')=((proof.verification_plan->'lean') - 'statement_review_id') END
  );
$$;

-- Intake and serving recompute the exact execution binding. SQL compares the complete pinned portable contract,
-- so a new validator, tool, invocation, layout, isolation policy or resource bound needs a new source review.
CREATE OR REPLACE FUNCTION lean_execution_review_current(subject_id bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM returns proof JOIN reviews rv ON rv.id::text=proof.verification_plan->'lean'->>'execution_review_id'
      JOIN returns source ON source.id=rv.return_id AND source.problem_id=proof.problem_id
    WHERE proof.id=subject_id AND proof.verification_plan->'lean'->>'policy'='lean-comparator-v2'
      AND source.verification_plan->'lean'->>'policy'='lean-comparator-v2'
      AND lean_tier1(proof.model,proof.effort) AND lean_tier1(source.model,source.effort)
      AND rv.trusted AND rv.verdict='accept' AND NOT rv.needs_reassessment
      AND source.status='accepted' AND NOT source.provisional
      AND lean_independent(proof.problem_id,rv.user_id,rv.model,rv.effort,proof.user_id,proof.model)
      AND lean_independent(proof.problem_id,rv.user_id,rv.model,rv.effort,source.user_id,source.model)
      AND rv.lean_execution_review->>'binding_sha256' ~ '^[a-f0-9]{64}$'
      AND length(trim(rv.lean_execution_review->>'correctness_md'))>=80
      AND jsonb_typeof(proof.verification_plan->'lean'->'execution_identity')='object'
      AND proof.verification_plan->'lean'->'execution_identity'->>'schema'='solveathome-lean-execution-contract-v2'
      AND rv.lean_execution_review->>'binding_sha256'=lean_identity_binding('solveathome-lean-execution-contract-v2',
        proof.verification_plan->'lean'->'execution_identity')
      AND source.verification_plan->'lean'->'execution_identity'=proof.verification_plan->'lean'->'execution_identity'
  );
$$;

-- Oct 8 2026: model diversity belongs to correctness review, not duplicate execution.
-- No backfill: historical receipts lack authenticated execution provenance and never acquire it by migration.
ALTER TABLE verification_runs ADD COLUMN IF NOT EXISTS execution_attestation jsonb;
CREATE OR REPLACE FUNCTION lean_execution_eligible(p_problem bigint, p_actor bigint, p_model text, p_effort text, p_author bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT lean_approved_member(p_problem,p_actor) AND lean_tier1(p_model,p_effort);
$$;
CREATE OR REPLACE FUNCTION lean_execution_authority(p_problem bigint, p_actor bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM problems WHERE id=p_problem AND researcher_user_id=p_actor)
    THEN jsonb_build_object('kind','researcher','user_id',p_actor)
    ELSE (SELECT jsonb_build_object('kind','grant','role',role,'granted_at',granted_at)
      FROM project_roles WHERE problem_id=p_problem AND user_id=p_actor AND revoked_at IS NULL) END;
$$;
-- Bind the whole observation and authenticated assignment without publishing session credentials or attempt IDs.
CREATE OR REPLACE FUNCTION lean_execution_snapshot(p_run_id bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('fingerprint',v.fingerprint,'outcome',v.outcome,'observed',v.observed,
    'elapsed_seconds',v.elapsed_seconds,'details',v.details,'subject_return_id',v.subject_return_id,'created_at',v.created_at,'result_return_id',r.id,'user_id',r.user_id,
    'model',r.model,'effort',r.effort,'job_id',r.job_id,'assignment_started_at',a.started_at)
  FROM verification_runs v JOIN returns r ON r.id=v.result_return_id
    JOIN jobs j ON j.id=r.job_id AND j.problem_id=r.problem_id AND j.type='check'
    JOIN assignment_attempts a ON a.id=j.attempt_id AND a.job_id=j.id AND a.problem_id=r.problem_id
      AND a.user_id=r.user_id AND a.session_id=r.session AND a.model=r.model AND a.status='completed'
    JOIN sessions s ON s.id=r.session AND s.user_id=r.user_id AND s.problem_id=r.problem_id AND s.model=r.model
  WHERE v.id=p_run_id;
$$;
-- V2 encoded exports are retained as exact transport files. Their declared decoded bytes remain scientific pins,
-- never an unavailable-file exemption. Intake binds these representations to the actual inert descriptor bytes.
CREATE OR REPLACE FUNCTION lean_identity_items(value jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END);
$$;
CREATE OR REPLACE FUNCTION lean_v2_proof_files_current(profile jsonb, evidence jsonb, result_id bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(evidence->>'policy'='lean-comparator-v2' AND jsonb_typeof(evidence->'proof_files')='array'
    AND jsonb_typeof(profile->'proof_representations')='array'
    AND evidence->>'scientific_identity'=lean_identity_binding('solveathome-lean-scientific-v2',profile->'scientific_identity')
    AND evidence->>'execution_identity'=lean_identity_binding('solveathome-lean-execution-contract-v2',profile->'execution_identity')
    AND NOT EXISTS(SELECT 1 FROM lean_identity_items(evidence->'proof_files') pf WHERE
      NOT EXISTS(SELECT 1 FROM lean_identity_items(profile->'proof_representations') expected WHERE expected=pf)
      OR NOT EXISTS(SELECT 1 FROM lean_identity_items(profile->'scientific_identity'->'proof_artifacts') proof
        WHERE proof->'artifact'=pf->'artifact' AND EXISTS(SELECT 1 FROM lean_identity_items(evidence->'claims') claim
          WHERE claim->>'proof_sha256'=pf->'artifact'->>'sha256' AND proof->'claim_ids' ? (claim->>'id')))
      OR NOT EXISTS(SELECT 1 FROM lean_identity_items(profile->'artifact_bindings') binding
        WHERE binding->'artifact'=pf->'artifact' AND CASE WHEN pf->'descriptor'='null'::jsonb THEN
          binding->'representation'->>'kind'='manifest' AND binding->'representation'->>'path'=pf->'artifact'->>'path'
          AND pf->'inputs'=jsonb_build_array(pf->'artifact') AND pf->'recipe'='null'::jsonb
        ELSE binding->'representation'->>'kind'='descriptor' AND binding->'representation'->>'path'=pf->'descriptor'->>'path'
          AND EXISTS(SELECT 1 FROM lean_identity_items(pf->'inputs')) AND EXISTS(
            SELECT 1 FROM lean_identity_items(profile->'execution_identity'->'package_artifacts') recipe WHERE recipe=pf->'recipe') END))
    AND (SELECT count(*)=count(DISTINCT pf->'artifact'->>'path') FROM lean_identity_items(evidence->'proof_files') pf)
    AND NOT EXISTS(SELECT 1 FROM lean_identity_items(evidence->'claims') claim
      WHERE claim->>'proof_sha256' IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM lean_identity_items(evidence->'proof_files') pf JOIN lean_identity_items(profile->'scientific_identity'->'proof_artifacts') proof
          ON proof->'artifact'=pf->'artifact'
        WHERE pf->'artifact'->>'sha256'=claim->>'proof_sha256' AND proof->'claim_ids' ? (claim->>'id')))
    AND NOT EXISTS(SELECT 1 FROM lean_identity_items(evidence->'proof_files') pf CROSS JOIN LATERAL (
      SELECT pf->'descriptor' AS artifact WHERE pf->'descriptor'<>'null'::jsonb
      UNION ALL SELECT input FROM lean_identity_items(pf->'inputs') input
      UNION ALL SELECT pf->'recipe' WHERE pf->'recipe'<>'null'::jsonb
    ) transport WHERE NOT EXISTS(
      SELECT 1 FROM lean_identity_items(profile->'manifest') pin WHERE pin->>'path'=transport.artifact->>'path' AND pin->>'sha256'=transport.artifact->>'sha256')
      OR NOT EXISTS(SELECT 1 FROM files f JOIN file_refs ref ON ref.file_sha=f.sha256
        WHERE f.sha256=transport.artifact->>'sha256' AND f.bytes::text=transport.artifact->>'bytes'
          AND f.deleted_at IS NULL AND ref.ref_type='return' AND ref.ref_id=result_id)),false);
$$;
-- A separate kernel profile never accepts comparator/export evidence as object replay evidence.
-- Exact scientific/execution pins accompany the authenticated current assignment, not historical backfill.
CREATE OR REPLACE FUNCTION lean_kernel_evidence_current(profile jsonb, evidence jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(profile->>'policy'='lean-kernel-v1' AND evidence->>'policy'='lean-kernel-v1'
    AND jsonb_typeof(evidence)='object' AND jsonb_typeof(evidence->'claims')='array'
    AND evidence->>'audit_sha256' ~ '^[a-f0-9]{64}$' AND evidence->>'axioms_sha256' ~ '^[a-f0-9]{64}$'
    AND evidence->>'custody_sha256' ~ '^[a-f0-9]{64}$'
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['sandbox','offline','clean_environment','pinned_inputs','outside_sandbox','kernel_checked','source_objects_verified']) flag
      WHERE jsonb_typeof(evidence->flag) IS DISTINCT FROM 'boolean')
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(evidence)='object' THEN evidence ELSE '{}'::jsonb END) key WHERE key NOT IN
      ('policy','statement_binding','scientific_identity','execution_identity','toolchain','validator_sha256','audit_sha256','axioms_sha256','custody_sha256',
       'sandbox','offline','clean_environment','pinned_inputs','outside_sandbox','kernel_checked','source_objects_verified','claims'))
    AND evidence->>'statement_binding'=lean_identity_binding('solveathome-lean-meaning-v2',(profile->'scientific_identity')-'proof_artifacts')
    AND evidence->>'scientific_identity'=lean_identity_binding('solveathome-lean-scientific-v2',profile->'scientific_identity')
    AND evidence->>'execution_identity'=lean_identity_binding('solveathome-lean-execution-contract-v2',profile->'execution_identity')
    AND evidence->>'toolchain'=profile->>'toolchain' AND evidence->>'validator_sha256'=profile->>'validator_sha256'
    AND (SELECT count(*)=count(DISTINCT claim->>'id') FROM lean_identity_items(evidence->'claims') claim)
    AND NOT EXISTS(SELECT 1 FROM lean_identity_items(evidence->'claims') claim WHERE
      jsonb_typeof(claim) IS DISTINCT FROM 'object' OR claim->>'result' IS NULL OR claim->>'result' NOT IN ('checked','failed','missing')
      OR NOT EXISTS(SELECT 1 FROM lean_identity_items(profile->'claims') expected
        WHERE expected->>'id'=claim->>'id' AND expected->>'declaration'=claim->>'declaration')
      OR jsonb_typeof(claim->'statement_matches') IS DISTINCT FROM 'boolean' OR jsonb_typeof(claim->'axioms') IS DISTINCT FROM 'array'
      OR NOT (claim ? 'object_sha256')
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(claim)='object' THEN claim ELSE '{}'::jsonb END) key WHERE key NOT IN ('id','declaration','result','statement_matches','axioms','object_sha256'))
      OR (claim->>'result'='checked' AND claim->>'object_sha256' IS NULL)
      OR (claim->>'object_sha256' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lean_identity_items(profile->'kernel_objects') object
        WHERE object->'claim_ids' ? (claim->>'id') AND object->'artifact'->>'sha256'=claim->>'object_sha256'))),false);
$$;
CREATE OR REPLACE FUNCTION lean_execution_current(p_run_id bigint, p_subject_id bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM verification_runs v JOIN returns r ON r.id=v.result_return_id
    JOIN returns subject ON subject.id=p_subject_id AND subject.problem_id=r.problem_id
      AND subject.verification_fingerprint=v.fingerprint
    WHERE v.id=p_run_id AND lean_tier1(subject.model,subject.effort)
      AND lean_execution_eligible(subject.problem_id,r.user_id,r.model,r.effort,subject.user_id)
      AND CASE subject.verification_plan->'lean'->>'policy'
        WHEN 'lean-comparator-v2' THEN lean_statement_review_current(subject.id) AND lean_execution_review_current(subject.id)
        WHEN 'lean-kernel-v1' THEN lean_statement_review_current(subject.id)
          AND subject.verification_fingerprint=lean_identity_binding('solveathome-verification-v1',subject.verification_plan-'cost')
        ELSE true END
      AND v.execution_attestation->>'version'='authenticated-contributor-v1'
      AND v.details->>'execution_policy'='authenticated-contributor-v1'
      AND length(trim(v.details->>'attestation_md'))>=40
      AND v.execution_attestation->'authority'=lean_execution_authority(subject.problem_id,r.user_id)
      AND v.execution_attestation->'receipt'=lean_execution_snapshot(v.id)
      AND (subject.verification_plan->'lean'->>'policy'<>'lean-comparator-v2' OR v.details->'lean' IS NULL
        OR lean_v2_proof_files_current((subject.verification_plan->'lean')||jsonb_build_object('manifest',subject.verification_plan->'manifest'),v.details->'lean',r.id))
      AND (subject.verification_plan->'lean'->>'policy'<>'lean-kernel-v1' OR
        (v.outcome='unable' AND v.details->'lean' IS NULL) OR lean_kernel_evidence_current(subject.verification_plan->'lean',v.details->'lean'))
      AND NOT EXISTS(SELECT 1 FROM (
        SELECT unnest(ARRAY[v.details->>'stdout_sha256',v.details->'lean'->>'audit_sha256',v.details->'lean'->>'axioms_sha256',
          CASE WHEN subject.verification_plan->'lean'->>'policy'='lean-kernel-v1' THEN v.details->'lean'->>'custody_sha256' END]) AS sha
        UNION SELECT claim->>'proof_sha256' FROM jsonb_array_elements(coalesce(v.details->'lean'->'claims','[]'::jsonb)) claim
          WHERE subject.verification_plan->'lean'->>'policy' NOT IN ('lean-comparator-v2','lean-kernel-v1')
      ) artifact WHERE artifact.sha IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM files f JOIN file_refs ref ON ref.file_sha=f.sha256
        WHERE f.sha256=artifact.sha AND f.deleted_at IS NULL AND ref.ref_type='return' AND ref.ref_id=r.id)));
$$;

-- Record challenges (Oct 9 2026, the MD5 Research Challenge; src/lib/challenges.ts). A submission's id is its receipt sequence:
-- it is written under the project lock, so id order is arrival order. Rows are never rewritten; corrections are rows of their own.
CREATE TABLE IF NOT EXISTS challenge_submissions (
  id               BIGSERIAL PRIMARY KEY,
  problem_id       BIGINT NOT NULL REFERENCES problems(id),
  challenge_id     TEXT NOT NULL,
  namespace        TEXT NOT NULL DEFAULT 'live' CHECK (namespace IN ('live','demo')),   -- demo: test data, never on the records, deletable by its submitter
  user_id          BIGINT NOT NULL REFERENCES users(id),
  session_id       TEXT,
  job_id           BIGINT REFERENCES jobs(id),
  model            TEXT,
  idempotency_key  TEXT NOT NULL,
  request_sha256   TEXT NOT NULL,
  identity_sha256  TEXT NOT NULL,       -- domain-separated SHA-256 of the exact inputs, never their MD5
  inputs           JSONB NOT NULL,      -- canonical transport form: candidate, input_hex, or a_hex and b_hex sorted by bytes
  digest           TEXT NOT NULL,
  score            INT,
  byte_length      INT,
  a_bytes          INT,
  b_bytes          INT,
  total_bytes      INT,
  duplicate_of     BIGINT REFERENCES challenge_submissions(id),
  known_result     BOOLEAN NOT NULL DEFAULT false,   -- reproduces a published result: its discoverer keeps the discovery credit
  attribution      TEXT,
  method_md        TEXT,
  ai_involvement   TEXT,                -- self-reported, shown as such
  runtime_s        NUMERIC,
  hardware         TEXT,
  verifier_version TEXT NOT NULL,
  checks           JSONB NOT NULL,      -- the digest from each independent implementation
  response         JSONB,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  verified_at      TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS challenge_submissions_track_idx ON challenge_submissions (problem_id, challenge_id, namespace, id);
CREATE INDEX IF NOT EXISTS challenge_submissions_identity_idx ON challenge_submissions (identity_sha256);
CREATE INDEX IF NOT EXISTS challenge_submissions_user_idx ON challenge_submissions (user_id, received_at);
-- What a receipt earned when it arrived: milestones, records, reaching the published target. One winner per value, by the unique index.
CREATE TABLE IF NOT EXISTS challenge_events (
  id            BIGSERIAL PRIMARY KEY,
  problem_id    BIGINT NOT NULL REFERENCES problems(id),
  challenge_id  TEXT NOT NULL,
  namespace     TEXT NOT NULL DEFAULT 'live',
  kind          TEXT NOT NULL CHECK (kind IN ('milestone','record','target')),
  value         INT NOT NULL,
  submission_id BIGINT NOT NULL REFERENCES challenge_submissions(id),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS challenge_events_one_winner ON challenge_events (problem_id, challenge_id, namespace, kind, value);
-- Verifier defects and attribution corrections: dated, append-only; the current view applies the latest.
CREATE TABLE IF NOT EXISTS challenge_corrections (
  id            BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES challenge_submissions(id),
  kind          TEXT NOT NULL CHECK (kind IN ('void','restore','attribution')),
  note          TEXT NOT NULL,
  attribution   TEXT,
  user_id       BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS challenge_corrections_submission_idx ON challenge_corrections (submission_id, id);
-- The report that closes a track assignment.
CREATE TABLE IF NOT EXISTS challenge_reports (
  id          BIGSERIAL PRIMARY KEY,
  problem_id  BIGINT NOT NULL REFERENCES problems(id),
  job_id      BIGINT NOT NULL REFERENCES jobs(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  session_id  TEXT,
  model       TEXT,
  report_md   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Readable exposition versions reuse accepted proof evidence without replacing its manuscript.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS paper_exposition JSONB;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS paper_exposition_review JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS exposition_source_return_id BIGINT REFERENCES returns(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS exposition_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_exposition_scope_unique ON jobs(problem_id,exposition_key) WHERE exposition_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS returns_paper_exposition_idx ON returns(problem_id,paper_slug,id) WHERE paper_exposition IS NOT NULL;

-- Review quorum (Oct 9 2026, src/lib/consensus.ts): on a project with review_quorum above 1 one approved person may give a second verdict
-- with another tier-1 model family. One review per person per family; the app keeps one per person on every other project.
CREATE UNIQUE INDEX IF NOT EXISTS reviews_return_user_family_idx ON reviews (return_id, user_id, coalesce(lean_model_family(model), model));
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_return_id_user_id_key;

-- Shared collaboration is optional, additive metadata; it never changes a historical verdict.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS research_task JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS step_checked_vector JSONB;
ALTER TABLE assignment_attempts ADD COLUMN IF NOT EXISTS research_context JSONB;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS research_evidence JSONB;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS research_assessment JSONB;
CREATE TABLE IF NOT EXISTS research_links (
  id BIGSERIAL PRIMARY KEY,
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  subject_return_id BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  scope_key TEXT,
  route_id BIGINT REFERENCES research_routes(id) ON DELETE CASCADE,
  topic_id TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('bears_on','addresses','contradicts','reuses','replicates')),
  rationale_md TEXT NOT NULL,
  provenance_return_id BIGINT REFERENCES returns(id) ON DELETE CASCADE,
  provenance_review_id BIGINT, -- preserved when an assessment is archived/replaced; checked on insertion
  supersedes_id BIGINT REFERENCES research_links(id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (route_id IS NOT NULL OR topic_id IS NOT NULL),
  CHECK (num_nonnulls(provenance_return_id,provenance_review_id)=1)
);
CREATE INDEX IF NOT EXISTS research_links_route_idx ON research_links(problem_id,route_id,id);
CREATE INDEX IF NOT EXISTS research_links_topic_idx ON research_links(problem_id,topic_id,id);
CREATE INDEX IF NOT EXISTS research_links_subject_idx ON research_links(subject_return_id,id);
CREATE INDEX IF NOT EXISTS research_links_supersedes_idx ON research_links(supersedes_id);
CREATE INDEX IF NOT EXISTS returns_research_topics_idx ON returns USING gin ((research_evidence->'topic_ids'));
CREATE OR REPLACE FUNCTION research_link_project_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM returns WHERE id=NEW.subject_return_id AND problem_id=NEW.problem_id)
    OR (NEW.route_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM research_routes WHERE id=NEW.route_id AND problem_id=NEW.problem_id))
    OR (NEW.provenance_return_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM returns WHERE id=NEW.provenance_return_id AND problem_id=NEW.problem_id))
    OR (NEW.provenance_review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reviews v JOIN returns r ON r.id=v.return_id WHERE v.id=NEW.provenance_review_id AND r.problem_id=NEW.problem_id))
    OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM research_links WHERE id=NEW.supersedes_id AND problem_id=NEW.problem_id))
  THEN RAISE EXCEPTION 'research link must remain within its project'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS research_link_project_guard_trigger ON research_links;
CREATE TRIGGER research_link_project_guard_trigger BEFORE INSERT ON research_links FOR EACH ROW EXECUTE FUNCTION research_link_project_guard();
