-- Running agent version, reported by the agent on every connection (agent.hello).
-- Lets the UI show each device's agent version and warn when it lags the server.

ALTER TABLE devices
    ADD COLUMN agent_version VARCHAR(64) NULL;
