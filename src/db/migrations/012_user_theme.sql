-- User theme preferences (accent, background preset, image, dim, blur).
-- MEDIUMTEXT (max 16 MB) to accommodate base64 wallpaper data URLs (~4 MB).
ALTER TABLE users
    ADD COLUMN theme MEDIUMTEXT NULL DEFAULT NULL;
