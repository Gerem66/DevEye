import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sqlTableTargets } from './sql-tables';

test('sqlTableTargets voit le DDL, le DML et les deux côtés d’un RENAME', () => {
    const sql = `
        -- un commentaire qui cite INSERT INTO nowhere ne compte pas comme du SQL ? si : la sentinelle est textuelle, et c'est voulu
        CREATE TABLE IF NOT EXISTS ft_x_items (id INT);
        ALTER TABLE \`ft_x_items\` ADD COLUMN n INT;
        CREATE UNIQUE INDEX idx ON ft_x_items (n);
        INSERT IGNORE INTO workspaces (id) VALUES (1);
        REPLACE INTO feature_kv (k) VALUES ('a');
        UPDATE users SET name = 'x';
        DELETE FROM notes WHERE 1;
        TRUNCATE TABLE logs;
        RENAME TABLE ft_x_old TO ft_x_new, passwords TO vault;
        CREATE TRIGGER trg BEFORE INSERT ON devices FOR EACH ROW SET NEW.x = 1;
        DROP VIEW IF EXISTS v_stats;
        LOAD DATA INFILE 'f' INTO TABLE audience_events;
    `;
    assert.deepEqual(
        new Set(sqlTableTargets(sql)),
        new Set([
            'nowhere',
            'ft_x_items',
            'workspaces',
            'feature_kv',
            'users',
            'notes',
            'logs',
            'ft_x_old',
            'ft_x_new',
            'passwords',
            'vault',
            'trg',
            'devices',
            'v_stats',
            'audience_events'
        ])
    );
});
