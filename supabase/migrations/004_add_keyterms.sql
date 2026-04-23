ALTER TABLE shops
    ADD COLUMN keyterms_json jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE shops
SET keyterms_json = '["Riyaaz", "tabla", "harmonium", "sitar", "Sandip Ghosh", "Happy Singh"]'::jsonb
WHERE slug = 'riyaaz';
