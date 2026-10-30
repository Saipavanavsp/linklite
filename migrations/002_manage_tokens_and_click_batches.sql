-- SHA-256 of the per-link management token. Links created before this
-- migration have none and can't be edited or deleted through the API.
ALTER TABLE links ADD COLUMN manage_token_hash TEXT;

-- ids of click batches already added to links.clicks. A batch id starts with
-- its timestamp, so old rows can be pruned with a range delete on the key.
CREATE TABLE click_batches (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
