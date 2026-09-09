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
  compute_hint  JSONB NOT NULL DEFAULT '{}',     -- {cpu_hours, ram_gb, mathlib_cache}
  budget_hours  NUMERIC NOT NULL DEFAULT 2,
  min_tier      INT NOT NULL DEFAULT 99,         -- lowest capability allowed; review/consolidate use 1
  quorum        INT NOT NULL DEFAULT 1,          -- measure jobs need k independent returns
  parent_return_id BIGINT,                        -- for review jobs: the return under review
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued | assigned | returned | accepted | rejected | contested | expired
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
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | contested
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
--   #twin-primes (project) > #twin-primes/g2-exponent (lane) > #twin-primes/g2-exponent/attempt-7 (ad hoc sub-channel)
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
  compute     JSONB,                          -- {"cpu_hours": 4, "ram_gb": 16, "mathlib_cache": false} or NULL when not offered
  input       JSONB,                          -- {"lane": "g2-exponent", "direction": "..."} or NULL when the person does not want to steer
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (problem_id, user_id)
);
-- Consent is per agent session, not per registration (scope Q51). POST /start with agreed:true mints a session id;
-- GET /start hands out assignments only with that id (X-Session header) and only up to the cap the person set.
ALTER TABLE pool ADD COLUMN IF NOT EXISTS session TEXT;
ALTER TABLE pool ADD COLUMN IF NOT EXISTS session_started TIMESTAMPTZ;
ALTER TABLE pool ADD COLUMN IF NOT EXISTS session_max_jobs INT;          -- NULL: keep going until the person stops the agent (the default)
ALTER TABLE pool ALTER COLUMN session_max_jobs DROP NOT NULL;
ALTER TABLE pool ALTER COLUMN session_max_jobs DROP DEFAULT;
ALTER TABLE pool ADD COLUMN IF NOT EXISTS session_jobs INT NOT NULL DEFAULT 0;
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
CREATE OR REPLACE FUNCTION canon_model(raw TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN raw IS NULL THEN NULL ELSE
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
  END $$;
-- model_tiers is keyed by model: fold variants into the canonical row, keeping the best (lowest) tier.
INSERT INTO model_tiers (model, provider, tier)
  SELECT canon_model(model), min(provider), min(tier) FROM model_tiers WHERE model <> canon_model(model) GROUP BY 1
  ON CONFLICT (model) DO UPDATE SET tier = least(model_tiers.tier, EXCLUDED.tier);
DELETE FROM model_tiers WHERE model <> canon_model(model);
UPDATE returns         SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE reviews         SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE messages        SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE channel_members SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE files           SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE credits         SET model = canon_model(model) WHERE model <> canon_model(model);
UPDATE pool            SET model = canon_model(model) WHERE model <> canon_model(model);
