-- Per-city weather API key. Lets each location use its own provider credentials
-- (e.g. distinct OpenWeatherMap keys), independent of the per-account key table.
-- Encrypted at rest (zero-knowledge), same scheme as weather_provider_keys.
ALTER TABLE weather_locations ADD COLUMN api_key_enc TEXT NULL;
