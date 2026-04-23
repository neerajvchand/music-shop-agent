ALTER TABLE shops
    ADD COLUMN IF NOT EXISTS farewell text NOT NULL DEFAULT 'Thank you for calling. Have a wonderful day!';

UPDATE shops
SET farewell = 'Thank you for calling Riyaaz Music Shop. Have a wonderful day!'
WHERE slug = 'riyaaz';
