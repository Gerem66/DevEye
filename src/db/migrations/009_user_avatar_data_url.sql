-- Widen users.avatar so it can hold a base64 image data URL (uploaded profile
-- picture) instead of only a short filename. MEDIUMTEXT (16 MB) comfortably
-- covers a client-resized thumbnail; the WS contract caps the real size.
ALTER TABLE users
    MODIFY COLUMN avatar MEDIUMTEXT NOT NULL DEFAULT ('default-user.png');
