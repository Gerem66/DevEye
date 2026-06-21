-- Device lifecycle v2: managed deletion (agent self-destruct → archive) and
-- reactivation. Widen the status vocabulary, remember the pre-deletion status so
-- a pending deletion can be cancelled, and store a self-destruct failure so the
-- Appareils page can surface an aborted deletion.
--
-- `status` was VARCHAR(16); 'pending_deletion' is exactly 16 chars, so widen to
-- 20 for headroom.

ALTER TABLE devices
    MODIFY status VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN status_before_delete VARCHAR(20)  NULL,
    ADD COLUMN delete_error         VARCHAR(255) NULL;
