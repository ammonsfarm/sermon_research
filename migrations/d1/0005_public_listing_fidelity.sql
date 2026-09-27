-- Phase 4 public-listing fidelity, contract p4-v2.
-- This migration is additive. Existing rows receive the neutral `article`
-- classification until Gate G2 supplies the source-authoritative CMS enum.

ALTER TABLE articles ADD COLUMN content_type TEXT NOT NULL DEFAULT 'article'
  CHECK (content_type IN (
    'devotional',
    'bible-study',
    'article',
    'written-resource',
    'newsletter-archive'
  ));

CREATE INDEX IF NOT EXISTS idx_articles_public_content_type
  ON articles(content_type, published_at DESC, article_id ASC);
