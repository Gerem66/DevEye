-- Les alertes Uptime s'envoient via un compte de la feature Mail (obligatoirement
-- « open », le planificateur tournant sans session ni mot de passe).
ALTER TABLE uptime_settings
    ADD COLUMN mail_account_id INT NULL AFTER email_enc,
    ADD CONSTRAINT fk_uptime_settings_mail_account
        FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE SET NULL;
