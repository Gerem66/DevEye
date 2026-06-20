-- Allow link codes that never expire (NULL = no expiry). Codes can also carry a
-- custom or default lifetime; NULL opts out of expiry entirely.

ALTER TABLE device_link_codes
    MODIFY COLUMN expires_at BIGINT NULL;
