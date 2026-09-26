-- Quand les conditions d'utilisation du site ont ete acceptees (secondes), de
-- la demande d'inscription au compte. NULL : compte cree sans site (auto-heberge
-- ou anterieur).
ALTER TABLE pending_signups ADD COLUMN terms_accepted_at BIGINT NULL;
ALTER TABLE users ADD COLUMN terms_accepted_at BIGINT NULL;
