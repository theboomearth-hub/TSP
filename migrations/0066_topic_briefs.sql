-- Topic-first writing: the related stories a topic search found, kept for 24 hours so a post can
-- be written from the ones the person ticks. The server rebuilds the writer's brief from these
-- rows; story text never comes from the browser. Additive only.
CREATE TABLE IF NOT EXISTS topic_briefs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic text NOT NULL CONSTRAINT topic_briefs_topic_length CHECK (char_length(btrim(topic)) BETWEEN 1 AND 200),
  searched_for text NOT NULL DEFAULT '',
  stories jsonb NOT NULL DEFAULT '[]'::jsonb,
  angles jsonb,
  picked jsonb NOT NULL DEFAULT '[]'::jsonb,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS topic_briefs_owner_created_idx ON topic_briefs (tenant_id, user_id, created_at DESC);

ALTER TABLE topic_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_briefs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topic_briefs;
CREATE POLICY tenant_isolation ON topic_briefs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON topic_briefs TO tsp_app;
