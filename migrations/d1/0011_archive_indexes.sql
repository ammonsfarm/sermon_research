-- Console archive performance: the episode list evaluates per-episode coverage flags.
-- Without these, each flag scanned podtrac_episodes or every verified vector row
-- (23 s and ~8.8M rows read for one 240-row archive page).

CREATE INDEX IF NOT EXISTS idx_podtrac_episodes_episode
  ON podtrac_episodes(episode_id);

CREATE INDEX IF NOT EXISTS idx_vector_documents_source_id_status
  ON vector_documents(source_id, source_type, status);

CREATE INDEX IF NOT EXISTS idx_episodes_publish_date_title
  ON episodes(publish_date DESC, title);
