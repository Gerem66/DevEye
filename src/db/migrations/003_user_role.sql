-- Global account role (user|admin). Admins manage every device.
ALTER TABLE users
    ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user' AFTER avatar;
