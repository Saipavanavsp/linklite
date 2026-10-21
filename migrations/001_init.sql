CREATE TABLE links (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  url         TEXT NOT NULL,
  clicks      BIGINT NOT NULL DEFAULT 0,
  is_custom   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  -- the unique constraint creates the b-tree index every lookup by code uses
  CONSTRAINT links_code_key UNIQUE (code)
);

-- only links that can expire are indexed, for a future cleanup job
CREATE INDEX links_expires_at_idx ON links (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE id_counter (
  id    SMALLINT PRIMARY KEY CHECK (id = 1),
  value BIGINT NOT NULL
);

-- 62^3 - 1, so the first generated code is "1000" (4 characters), same as sqlite
INSERT INTO id_counter (id, value) VALUES (1, 238327);
