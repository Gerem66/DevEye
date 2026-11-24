-- Les etapes de donnees deja jouees (db/dataSteps.ts) : les reprises qu'un
-- module ecrit en TypeScript parce qu'il leur faut une cle, une ligne par etape,
-- sous <module>/<id>. Le pendant de _migrations.
CREATE TABLE IF NOT EXISTS _data_steps (
    name        VARCHAR(255) NOT NULL PRIMARY KEY,
    applied_at  BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
