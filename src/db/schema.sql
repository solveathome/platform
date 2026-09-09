-- solveathome schema. Applied idempotently on boot (see src/db/index.ts).

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  github_id   BIGINT UNIQUE NOT NULL,
  handle      TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
