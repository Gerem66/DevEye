-- Build target the agent was compiled for (e.g. `linux-x86_64`), reported on
-- every connection (agent.hello). Lets the server resolve which signed binary to
-- push for a self-update. NULL until an agent that supports self-update connects.

ALTER TABLE devices
    ADD COLUMN agent_target VARCHAR(32) NULL;
