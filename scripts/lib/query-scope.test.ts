import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    callVerdict,
    classifyTables,
    scopeFileSchema,
    scopeFindings,
    type Schema,
    type TableDeclaration,
    type TableInfo
} from './query-scope';

function table(columns: string[], foreignKeys: Record<string, string> = {}, primaryKey = ['id']): TableInfo {
    return {
        columns: new Set(columns),
        primaryKey: primaryKey.filter((c) => columns.includes(c)),
        foreignKeys: new Map(Object.entries(foreignKeys))
    };
}

const SCHEMA: Schema = new Map([
    ['users', table(['id', 'email'])],
    ['workspaces', table(['id', 'owner_user_id'], { owner_user_id: 'users' })],
    ['sessions', table(['id', 'user_id', 'token_hash'], { user_id: 'users' })],
    ['instance_settings', table(['k', 'value', 'updated_by'], { updated_by: 'users' }, ['k'])],
    ['catalog', table(['id', 'name'])],
    ['note_folders', table(['id', 'workspace_id', 'name'], { workspace_id: 'workspaces' })],
    [
        'notes',
        table(['id', 'workspace_id', 'user_id', 'folder_id', 'public', 'content'], {
            workspace_id: 'workspaces',
            user_id: 'users',
            folder_id: 'note_folders'
        })
    ],
    ['note_tags', table(['id', 'note_id', 'tag'], { note_id: 'notes' })],
    ['tag_votes', table(['id', 'tag_id', 'site_id', 'user_id'], { tag_id: 'note_tags', user_id: 'users' })],
    ['item_shares', table(['id', 'feature', 'item_id', 'home_workspace_id', 'workspace_id'])],
    ['devices', table(['id', 'workspace_id', 'retention_days'])],
    ['device_metrics', table(['device_id', 'ts', 'value'], { device_id: 'devices' }, ['device_id', 'ts'])],
    ['events', table(['id', 'site_id', 'ts'])]
]);

const DECLARED = new Map<string, TableDeclaration>([
    ['users', { class: 'account', columns: ['id'] }],
    ['workspaces', { class: 'account', columns: ['id', 'owner_user_id'] }],
    ['sessions', { class: 'account', columns: ['user_id'] }],
    ['instance_settings', { class: 'instance', reason: 'Les réglages de l’instance.' }]
]);

const { scopes: SCOPES } = classifyTables(SCHEMA, DECLARED);

const findings = (sql: string, rowId?: (param: number) => boolean): string[] =>
    scopeFindings(sql, SCHEMA, SCOPES, { rowId }).map((f) => `${f.kind} ${f.table ?? '-'}`);

describe('classifyTables', () => {
    it('range une table qui porte son espace, et ses filles de proche en proche', () => {
        assert.deepEqual(SCOPES.get('notes'), {
            class: 'direct',
            columns: ['workspace_id'],
            joins: ['folder_id'],
            keys: []
        });
        assert.deepEqual(SCOPES.get('note_tags'), { class: 'child', columns: ['note_id'], joins: [], keys: [] });
        assert.deepEqual(SCOPES.get('tag_votes'), { class: 'child', columns: ['tag_id'], joins: [], keys: [] });
        assert.deepEqual(SCOPES.get('item_shares')?.columns, ['workspace_id', 'home_workspace_id']);
    });

    it('ne fait jamais une fille par une clé vers un compte', () => {
        const { scopes, unclassified } = classifyTables(SCHEMA, new Map());
        assert.equal(scopes.has('sessions'), false);
        assert.equal(scopes.has('instance_settings'), false);
        assert.deepEqual(unclassified, ['catalog', 'events', 'instance_settings', 'sessions', 'users', 'workspaces']);
    });

    it('suit les déclarations, et laisse sans classe ce que rien ne range', () => {
        const { unclassified, problems } = classifyTables(SCHEMA, DECLARED);
        assert.deepEqual(SCOPES.get('sessions'), { class: 'account', columns: ['user_id'], joins: [], keys: [] });
        assert.equal(SCOPES.get('instance_settings')?.class, 'instance');
        assert.deepEqual(unclassified, ['catalog', 'events']);
        assert.deepEqual(problems, []);
    });

    it('fait une fille d’une table dont le schéma ne dit pas le parent', () => {
        const declared = new Map<string, TableDeclaration>([
            ...DECLARED,
            ['events', { class: 'child', parents: { site_id: 'devices' } }]
        ]);
        const { scopes, problems } = classifyTables(SCHEMA, declared);
        assert.deepEqual(scopes.get('events'), { class: 'child', columns: ['site_id'], joins: [], keys: [] });
        assert.deepEqual(problems, []);
    });

    it('refuse une déclaration fausse ou inutile', () => {
        const declared = new Map<string, TableDeclaration>([
            ['gone', { class: 'instance', reason: 'x' }],
            ['notes', { class: 'instance', reason: 'x' }],
            ['sessions', { class: 'account', columns: ['owner'] }],
            ['events', { class: 'child', parents: { site_id: 'users' } }]
        ]);
        const { scopes, problems } = classifyTables(SCHEMA, declared);
        assert.deepEqual(problems, [
            '« gone » est déclarée, mais la base ne la connaît pas',
            "« notes » porte workspace_id : elle n'a pas à être déclarée",
            '« sessions » : colonne déclarée inconnue (owner)',
            "« events » : parent déclaré qui n'est pas une table d'espace (users)"
        ]);
        assert.equal(scopes.get('notes')?.class, 'direct');
        assert.equal(scopes.has('events'), false);
    });
});

describe('scopeFindings : une table d’espace', () => {
    it('est bornée par un prédicat sur son espace', () => {
        assert.deepEqual(findings('SELECT * FROM notes WHERE workspace_id = ? AND id = ?'), []);
        assert.deepEqual(findings('SELECT * FROM notes n WHERE n.workspace_id IN (?)'), []);
        assert.deepEqual(findings('UPDATE notes SET content = ? WHERE id = ? AND workspace_id = ?'), []);
        assert.deepEqual(findings('DELETE FROM notes WHERE workspace_id = ?'), []);
    });

    it('ne l’est ni par sa clé, ni par son auteur, ni par son parent, ni par rien', () => {
        assert.deepEqual(findings('SELECT * FROM notes WHERE id = ?'), ['unbounded notes']);
        assert.deepEqual(findings('SELECT * FROM notes WHERE user_id = ?'), ['unbounded notes']);
        assert.deepEqual(findings('SELECT * FROM notes WHERE folder_id = ?'), ['unbounded notes']);
        assert.deepEqual(findings('SELECT COUNT(*) AS n FROM notes'), ['unbounded notes']);
        assert.deepEqual(findings('UPDATE notes SET content = ? WHERE id = ?'), ['unbounded notes']);
        assert.deepEqual(findings('DELETE FROM notes WHERE id = ?'), ['unbounded notes']);
    });

    it('ne l’est pas par une comparaison qui n’est pas une égalité', () => {
        assert.deepEqual(findings('SELECT * FROM notes WHERE workspace_id <> ?'), ['unbounded notes']);
        assert.deepEqual(findings('SELECT * FROM notes WHERE workspace_id NOT IN (?)'), ['unbounded notes']);
    });

    it('ne l’est pas par une branche d’un OU', () => {
        assert.deepEqual(findings('SELECT * FROM notes WHERE workspace_id = ? OR public = 1'), ['unbounded notes']);
        assert.deepEqual(findings('SELECT * FROM notes WHERE id = ? AND (workspace_id = ? OR public = 1)'), [
            'unbounded notes'
        ]);
        assert.deepEqual(
            findings('SELECT * FROM notes WHERE (workspace_id = ? AND public = 0) OR workspace_id = ?'),
            []
        );
    });

    it('accepte la clé d’une ligne que l’appelant vient d’insérer, et elle seule', () => {
        const sql = 'SELECT * FROM notes WHERE id = ?';
        assert.deepEqual(
            findings(sql, () => true),
            []
        );
        assert.deepEqual(
            findings('SELECT * FROM notes WHERE content = ? AND id = ?', (param) => param === 1),
            []
        );
        assert.deepEqual(
            findings('SELECT * FROM notes WHERE content = ? AND id = ?', (param) => param === 0),
            ['unbounded notes']
        );
        assert.deepEqual(
            findings('SELECT * FROM notes WHERE id IN (?)', () => true),
            ['unbounded notes']
        );
    });
});

describe('scopeFindings : jointures et sous-requêtes', () => {
    it('borne une table par sa jointure à des lignes bornées', () => {
        assert.deepEqual(
            findings('SELECT t.* FROM note_tags t JOIN notes n ON n.id = t.note_id WHERE n.workspace_id = ?'),
            []
        );
        assert.deepEqual(
            findings('SELECT n.* FROM notes n JOIN note_folders f ON f.id = n.folder_id WHERE f.workspace_id = ?'),
            []
        );
        assert.deepEqual(
            findings('SELECT f.* FROM note_folders f JOIN notes n ON n.folder_id = f.id WHERE n.workspace_id = ?'),
            []
        );
    });

    it('ne relève que la table qui nomme l’autre, quand la jointure ne mène à aucune borne', () => {
        assert.deepEqual(findings('SELECT t.* FROM note_tags t JOIN notes n ON n.id = t.note_id WHERE n.public = 1'), [
            'unbounded note_tags'
        ]);
        assert.deepEqual(
            findings('SELECT n.*, u.email FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.public = 1'),
            ['unbounded notes']
        );
    });

    it('laisse une table d’instance nommer un compte, pas l’inverse', () => {
        assert.deepEqual(
            findings('SELECT s.*, u.email FROM instance_settings s LEFT JOIN users u ON u.id = s.updated_by'),
            []
        );
        assert.deepEqual(findings('SELECT u.* FROM users u JOIN instance_settings s ON s.updated_by = u.id'), [
            'unbounded users'
        ]);
    });

    it('ne laisse pas deux tables se nommer l’une l’autre', () => {
        assert.deepEqual(
            findings('SELECT n.* FROM notes n JOIN note_folders f ON f.id = n.folder_id AND n.id = f.name'),
            ['unbounded notes']
        );
    });

    it('ne borne rien par une jointure sur une colonne quelconque', () => {
        assert.deepEqual(
            findings('SELECT f.* FROM note_folders f JOIN notes n ON n.content = f.name WHERE n.workspace_id = ?'),
            ['unbounded note_folders']
        );
    });

    it('ne borne pas une ligne d’espace par son auteur', () => {
        assert.deepEqual(findings('SELECT n.* FROM notes n JOIN users u ON u.id = n.user_id WHERE u.id = ?'), [
            'unbounded notes'
        ]);
    });

    it('borne l’auteur par la ligne d’espace qui le nomme', () => {
        assert.deepEqual(
            findings('SELECT u.email FROM notes n JOIN users u ON u.id = n.user_id WHERE n.workspace_id = ?'),
            []
        );
    });

    it('ne laisse le ON d’un LEFT JOIN borner que la table jointe', () => {
        assert.deepEqual(
            findings('SELECT n.* FROM notes n LEFT JOIN note_tags t ON t.note_id = n.id AND n.workspace_id = ?'),
            ['unbounded notes']
        );
        assert.deepEqual(
            findings('SELECT n.* FROM notes n LEFT JOIN note_tags t ON t.note_id = n.id WHERE n.workspace_id = ?'),
            []
        );
    });

    it('accepte le partage : la ligne de son espace, ou celle qu’un partage y amène', () => {
        assert.deepEqual(
            findings(
                "SELECT n.* FROM notes n WHERE n.id = ? AND (n.workspace_id = ? OR EXISTS (SELECT 1 FROM item_shares sh WHERE sh.feature = 'notes' AND sh.item_id = n.id AND sh.home_workspace_id = n.workspace_id AND sh.workspace_id = ?))"
            ),
            []
        );
    });

    it('relève un partage dont le EXISTS ne borne rien', () => {
        assert.deepEqual(
            findings(
                'SELECT n.* FROM notes n WHERE n.workspace_id = ? OR EXISTS (SELECT 1 FROM item_shares sh WHERE sh.item_id = n.id)'
            ),
            ['unbounded notes', 'unbounded item_shares']
        );
    });

    it('vérifie une sous-requête niée avec les lignes déjà bornées, sans rien en tirer', () => {
        assert.deepEqual(
            findings(
                'SELECT n.* FROM notes n WHERE n.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id)'
            ),
            []
        );
        assert.deepEqual(
            findings('SELECT n.* FROM notes n WHERE NOT EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = ?)'),
            ['unbounded notes']
        );
    });

    it('borne par un IN dont la sous-requête est bornée', () => {
        assert.deepEqual(
            findings('DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE workspace_id = ?)'),
            []
        );
        assert.deepEqual(
            findings('SELECT * FROM notes WHERE folder_id IN (SELECT id FROM note_folders WHERE workspace_id = ?)'),
            []
        );
        assert.deepEqual(findings('DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE public = 1)'), [
            'unbounded note_tags',
            'unbounded notes'
        ]);
        assert.deepEqual(
            findings('DELETE FROM note_tags WHERE tag IN (SELECT content FROM notes WHERE workspace_id = ?)'),
            ['unbounded note_tags']
        );
    });

    it('vérifie chaque branche d’un UNION', () => {
        const shared =
            'SELECT n.* FROM notes n JOIN item_shares sh ON sh.item_id = n.id AND sh.home_workspace_id = n.workspace_id';
        assert.deepEqual(
            findings(`SELECT n.* FROM notes n WHERE n.workspace_id = ? UNION ${shared} WHERE sh.workspace_id = ?`),
            []
        );
        assert.deepEqual(
            findings(`SELECT n.* FROM notes n WHERE n.workspace_id = ? UNION ${shared} WHERE sh.feature = ?`),
            ['unbounded notes', 'unbounded item_shares']
        );
    });

    it('vérifie une table dérivée par sa propre requête', () => {
        assert.deepEqual(
            findings('SELECT v.* FROM (SELECT * FROM notes WHERE workspace_id = ?) v WHERE v.public = 1'),
            []
        );
        assert.deepEqual(findings('SELECT v.* FROM (SELECT * FROM notes WHERE public = 1) v'), ['unbounded notes']);
        assert.deepEqual(
            findings(
                'SELECT t.* FROM note_tags t JOIN (SELECT id FROM notes WHERE workspace_id = ?) v ON v.id = t.note_id'
            ),
            []
        );
    });

    it('vérifie une CTE une fois, et s’appuie sur elle', () => {
        assert.deepEqual(
            findings(
                'WITH mine AS (SELECT id FROM notes WHERE workspace_id = ?) SELECT t.* FROM note_tags t JOIN mine ON mine.id = t.note_id'
            ),
            []
        );
        assert.deepEqual(findings('WITH every AS (SELECT id FROM notes) SELECT COUNT(*) AS n FROM every'), [
            'unbounded notes'
        ]);
    });

    it('vérifie les sous-requêtes de la liste rendue avec les lignes de dehors', () => {
        const count = '(SELECT COUNT(*) FROM note_tags t WHERE t.note_id = n.id) AS tags';
        assert.deepEqual(findings(`SELECT n.*, ${count} FROM notes n WHERE n.workspace_id = ?`), []);
        assert.deepEqual(
            findings('SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM devices) AS devices'),
            ['unbounded notes', 'unbounded devices']
        );
    });

    it('vérifie un UPDATE et un DELETE à jointure', () => {
        assert.deepEqual(
            findings(
                'UPDATE note_tags t JOIN notes n ON n.id = t.note_id SET t.tag = ? WHERE t.id = ? AND n.workspace_id = ?'
            ),
            []
        );
        assert.deepEqual(
            findings(
                'DELETE m FROM device_metrics m JOIN devices d ON d.id = m.device_id WHERE m.ts < ? - d.retention_days'
            ),
            ['unbounded device_metrics']
        );
    });
});

describe('scopeFindings : les autres classes', () => {
    it('borne une table fille par sa clé vers son parent', () => {
        assert.deepEqual(findings('SELECT * FROM note_tags WHERE note_id = ?'), []);
        assert.deepEqual(findings('SELECT * FROM device_metrics WHERE device_id = ? AND ts >= ?'), []);
        assert.deepEqual(findings('SELECT * FROM note_tags WHERE tag = ?'), ['unbounded note_tags']);
    });

    it('borne une table de compte par ses colonnes déclarées', () => {
        assert.deepEqual(findings('SELECT * FROM sessions WHERE user_id = ?'), []);
        assert.deepEqual(findings('SELECT * FROM users WHERE id = ?'), []);
        assert.deepEqual(findings('SELECT * FROM workspaces WHERE owner_user_id = ?'), []);
        assert.deepEqual(findings('SELECT * FROM sessions WHERE token_hash = ?'), ['unbounded sessions']);
        assert.deepEqual(findings('SELECT * FROM users WHERE email = ?'), ['unbounded users']);
    });

    it('ne demande rien à une table d’instance, à une table d’un autre schéma ni à une table inconnue', () => {
        assert.deepEqual(findings('SELECT * FROM instance_settings'), []);
        assert.deepEqual(
            findings('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'),
            []
        );
        assert.deepEqual(findings('SELECT 1 FROM dual'), []);
        assert.deepEqual(findings('SELECT GET_LOCK(?, ?) AS got'), []);
    });

    it('ne borne rien par une jointure à une table d’instance', () => {
        assert.deepEqual(findings('SELECT n.* FROM notes n JOIN instance_settings s ON s.value = n.workspace_id'), [
            'unbounded notes'
        ]);
    });

    it('signale une table sans classe, une fois', () => {
        assert.deepEqual(findings('SELECT * FROM catalog c JOIN catalog d ON d.id = c.id'), ['unclassified catalog']);
    });

    it('dit pourquoi une requête n’est pas analysée', () => {
        assert.deepEqual(scopeFindings('SELECT * FROM notes n NATURAL JOIN note_tags', SCHEMA, SCOPES), [
            { kind: 'unread', table: null, message: 'requête non analysée : NATURAL JOIN' }
        ]);
    });

    it('laisse passer ce qui n’est ni lecture ni écriture de lignes', () => {
        assert.deepEqual(findings('CREATE TABLE IF NOT EXISTS notes (id INT)'), []);
    });
});

describe('les clés qui désignent une ligne', () => {
    const KEYS = new Map([
        ['sessions', { columns: ['token_hash'], reason: 'Le jeton de la session.' }],
        ['users', { columns: ['email'], reason: 'Une adresse ne désigne qu’un compte.' }],
        ['devices', { columns: ['id'], reason: 'Un identifiant tiré au hasard.' }]
    ]);
    const keyed = classifyTables(SCHEMA, DECLARED, KEYS);
    const withKeys = (sql: string): string[] =>
        scopeFindings(sql, SCHEMA, keyed.scopes).map((f) => `${f.kind} ${f.table ?? '-'}`);

    it('bornent comme la colonne de la table', () => {
        assert.deepEqual(keyed.problems, []);
        assert.deepEqual(withKeys('SELECT * FROM sessions WHERE token_hash = ?'), []);
        assert.deepEqual(withKeys('SELECT * FROM users WHERE email = ? OR id = ?'), []);
        assert.deepEqual(withKeys('UPDATE devices SET retention_days = ? WHERE id = ?'), []);
        assert.deepEqual(withKeys('SELECT * FROM users WHERE email LIKE ?'), ['unbounded users']);
    });

    it('ne dispensent pas une insertion de porter la colonne de sa table', () => {
        assert.deepEqual(withKeys('INSERT INTO sessions (token_hash) VALUES (?)'), ['unbounded sessions']);
    });

    it('se refusent sur une table inconnue, une table qui n’est pas bornée, une colonne inconnue', () => {
        const { problems } = classifyTables(
            SCHEMA,
            DECLARED,
            new Map([
                ['gone', { columns: ['id'], reason: 'x' }],
                ['instance_settings', { columns: ['k'], reason: 'x' }],
                ['catalog', { columns: ['id'], reason: 'x' }],
                ['notes', { columns: ['public_ref'], reason: 'x' }]
            ])
        );
        assert.deepEqual(problems, [
            '« gone » a des clés déclarées, mais la base ne la connaît pas',
            "« instance_settings » n'est pas bornée : une clé n'y désigne rien",
            "« catalog » n'est pas bornée : une clé n'y désigne rien",
            '« notes » : clé déclarée inconnue (public_ref)'
        ]);
    });
});

describe('scopeFindings : les insertions', () => {
    it('exige la colonne d’espace, ou la clé du parent, dans la liste', () => {
        assert.deepEqual(findings('INSERT INTO notes (workspace_id, content) VALUES (?, ?)'), []);
        assert.deepEqual(findings('INSERT INTO notes (content) VALUES (?)'), ['unbounded notes']);
        assert.deepEqual(
            findings('INSERT INTO note_tags (note_id, tag) VALUES (?, ?) ON DUPLICATE KEY UPDATE tag = VALUES(tag)'),
            []
        );
        assert.deepEqual(findings('INSERT INTO note_tags (tag) VALUES (?)'), ['unbounded note_tags']);
        assert.deepEqual(findings('INSERT INTO sessions (user_id, token_hash) VALUES (?, ?)'), []);
    });

    it('refuse une insertion sans liste de colonnes', () => {
        assert.deepEqual(findings('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?)'), ['unbounded notes']);
    });

    it('laisse créer la ligne qui sert de racine', () => {
        assert.deepEqual(findings('INSERT INTO users (email) VALUES (?)'), []);
        assert.deepEqual(findings('INSERT INTO workspaces (owner_user_id) VALUES (?)'), []);
    });

    it('vérifie la requête d’un INSERT … SELECT', () => {
        assert.deepEqual(
            findings('INSERT INTO note_tags (note_id, tag) SELECT id, ? FROM notes WHERE workspace_id = ?'),
            []
        );
        assert.deepEqual(findings('INSERT INTO note_tags (note_id, tag) SELECT id, ? FROM notes WHERE public = 1'), [
            'unbounded notes'
        ]);
    });
});

describe('scopeFindings : le SQL assemblé à l’exécution', () => {
    it('juge ce qui se lit autour d’un morceau calculé', () => {
        assert.deepEqual(findings('UPDATE notes SET __DYNAMIC__ WHERE id = ? AND workspace_id = ?'), []);
        assert.deepEqual(findings('UPDATE notes SET __DYNAMIC__ WHERE id = ?'), ['unbounded notes']);
        assert.deepEqual(findings('SELECT __DYNAMIC__ FROM notes WHERE workspace_id = ? AND (__DYNAMIC__)'), []);
    });

    it('ne tient pour bornée aucune condition qu’un morceau calculé peut défaire', () => {
        assert.deepEqual(findings('SELECT * FROM notes WHERE workspace_id = ? __DYNAMIC__'), ['unbounded notes']);
        assert.deepEqual(findings('SELECT * FROM notes WHERE __DYNAMIC__'), ['unbounded notes']);
    });

    it('dit non lue une requête dont la table est calculée', () => {
        assert.deepEqual(findings('DELETE FROM __DYNAMIC__ WHERE workspace_id = ?'), ['unread -']);
        assert.deepEqual(findings('__DYNAMIC__'), ['unread -']);
    });
});

describe('callVerdict', () => {
    const finding = (kind: 'unbounded' | 'unclassified' | 'unread') => ({ kind, table: null, message: kind });

    it('rend le sort le plus grave', () => {
        assert.equal(callVerdict([], false), 'bounded');
        assert.equal(callVerdict([finding('unbounded')], false), 'unbounded');
        assert.equal(callVerdict([finding('unbounded'), finding('unread')], false), 'unread');
        assert.equal(callVerdict([finding('unread'), finding('unclassified')], false), 'unclassified');
    });

    it('laisse une dispense couvrir une table sans borne ou une requête non lue, jamais une table sans classe', () => {
        assert.equal(callVerdict([finding('unbounded')], true), 'exempt');
        assert.equal(callVerdict([finding('unread')], true), 'exempt');
        assert.equal(callVerdict([finding('unbounded'), finding('unclassified')], true), 'unclassified');
        assert.equal(callVerdict([], true), 'bounded');
    });
});

describe('scopeFileSchema', () => {
    it('lit des tables et des dispenses', () => {
        const file = scopeFileSchema.parse({
            tables: { sessions: { class: 'account', columns: ['user_id'] } },
            exempt: {
                'src/server/repo.ts#listDue': { kind: 'service', reason: 'Le planificateur lit tous les espaces.' }
            }
        });
        assert.deepEqual(Object.keys(file.exempt), ['src/server/repo.ts#listDue']);
    });

    it('rend un fichier vide pour un objet vide', () => {
        assert.deepEqual(scopeFileSchema.parse({}), { tables: {}, keys: {}, exempt: {} });
    });

    it('refuse une dispense sans raison, une clé sans fonction, une classe inconnue', () => {
        assert.equal(
            scopeFileSchema.safeParse({ exempt: { 'a.ts#f': { kind: 'service', reason: '' } } }).success,
            false
        );
        assert.equal(
            scopeFileSchema.safeParse({ exempt: { 'a.ts': { kind: 'service', reason: 'x' } } }).success,
            false
        );
        assert.equal(
            scopeFileSchema.safeParse({ exempt: { 'a.ts#f': { kind: 'autre', reason: 'x' } } }).success,
            false
        );
        assert.equal(scopeFileSchema.safeParse({ tables: { t: { class: 'direct' } } }).success, false);
        assert.equal(scopeFileSchema.safeParse({ tables: { t: { class: 'instance' } } }).success, false);
    });
});
