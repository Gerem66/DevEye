-- Les alertes Uptime s'envoient désormais via un compte configuré dans la
-- feature Mail (obligatoirement « open », puisque le planificateur tourne sans
-- session ni mot de passe) au lieu du SMTP global de `.env`. `SMTP_*` est
-- retiré séparément une fois cette bascule en place.
ALTER TABLE uptime_settings
    ADD COLUMN mail_account_id INT NULL AFTER email_enc,
    ADD CONSTRAINT fk_uptime_settings_mail_account
        FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE SET NULL;
