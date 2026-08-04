-- The HomeLayout contract changes shape: grid groups become modular "sections"
-- carrying their own id + optional title, several of the same kind are allowed,
-- and the navbar mini-widgets move out of the group array into their own field.
-- Stored layouts no longer validate against the new schema, so we clear them and
-- let every user start from the new default: an empty home.
UPDATE users SET home_layout = NULL;
