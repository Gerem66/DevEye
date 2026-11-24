import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readSql, tokenize, UnreadSql, type Block, type Cond, type Statement } from './sql-shape';

function select(sql: string): Block[] {
    const statement = readSql(sql);
    assert.equal(statement.kind, 'select');
    return (statement as Extract<Statement, { kind: 'select' }>).query;
}

function write(sql: string): Block {
    const statement = readSql(sql);
    assert.equal(statement.kind, 'write');
    return (statement as Extract<Statement, { kind: 'write' }>).block;
}

const tables = (block: Block): string[] => block.refs.map((r) => `${r.table ?? '(dérivée)'} ${r.alias}`);

/** La condition, réduite à sa structure : de quoi comparer sans recopier chaque champ. */
function shape(cond: Cond): unknown {
    switch (cond.kind) {
        case 'and':
        case 'or':
            return { [cond.kind]: cond.items.map(shape) };
        case 'bound':
            return `${cond.column.qualifier ?? ''}.${cond.column.name} = ${cond.param === null ? 'constante' : `?${cond.param}`}`;
        case 'link':
            return `${cond.left.qualifier ?? ''}.${cond.left.name} ~ ${cond.right.qualifier ?? ''}.${cond.right.name}`;
        case 'exists':
            return { exists: cond.query.map((b) => shape(b.cond)) };
        case 'in':
            return { in: `${cond.column.qualifier ?? ''}.${cond.column.name}`, of: cond.query.map(tables) };
        case 'only':
            return { only: cond.alias, item: shape(cond.item) };
        case 'opaque':
            return 'opaque';
    }
}

describe('tokenize', () => {
    it('numérote les paramètres et laisse de côté ceux d’une chaîne ou d’un commentaire', () => {
        const tokens = tokenize("SELECT '?', a -- ?\n FROM t /* ? */ WHERE b = ? AND c = ?");
        assert.deepEqual(
            tokens.filter((t) => t.kind === 'param').map((t) => t.param),
            [0, 1]
        );
    });

    it('garde une chaîne entière, apostrophe doublée ou échappée comprise', () => {
        const strings = tokenize("a = 'l''été' AND b = 'c\\'est' AND c = \"x\"").filter((t) => t.kind === 'str');
        assert.deepEqual(
            strings.map((t) => t.text),
            ["'l''été'", "'c\\'est'", '"x"']
        );
    });

    it('ne prend jamais un identifiant entre accents graves pour un mot-clé', () => {
        const [, order] = tokenize('SELECT `order`');
        assert.deepEqual({ text: order.text, upper: order.upper }, { text: 'order', upper: '' });
    });

    it('lit les opérateurs de plusieurs caractères d’un seul tenant', () => {
        assert.deepEqual(
            tokenize('a <=> b <> c >= d')
                .filter((t) => t.kind === 'punct')
                .map((t) => t.text),
            ['<=>', '<>', '>=']
        );
    });
});

describe('readSql : les tables', () => {
    it('lit les tables, leurs alias et les jointures', () => {
        const [block] = select(
            'SELECT n.* FROM notes n JOIN note_folders AS f ON f.id = n.folder_id LEFT JOIN users u ON u.id = n.user_id WHERE n.workspace_id = ?'
        );
        assert.deepEqual(tables(block), ['notes n', 'note_folders f', 'users u']);
        assert.deepEqual(shape(block.cond), {
            and: ['f.id ~ n.folder_id', { only: 'u', item: 'u.id ~ n.user_id' }, 'n.workspace_id = ?0']
        });
    });

    it('prend le nom de la table pour alias quand elle n’en a pas', () => {
        const [block] = select('SELECT * FROM notes WHERE workspace_id = ? ORDER BY id LIMIT ?');
        assert.deepEqual(tables(block), ['notes notes']);
        assert.deepEqual(shape(block.cond), { and: ['.workspace_id = ?0'] });
    });

    it('marque une table d’un autre schéma', () => {
        const [block] = select('SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
        assert.equal(block.refs[0].foreign, true);
    });

    it('passe les indications d’index', () => {
        const [block] = select('SELECT * FROM notes FORCE INDEX (by_ws) WHERE workspace_id = ?');
        assert.deepEqual(tables(block), ['notes notes']);
    });

    it('rend une branche par SELECT d’un UNION', () => {
        const query = select(
            'SELECT n.* FROM notes n WHERE n.workspace_id = ? UNION ALL SELECT n.* FROM notes n JOIN item_shares sh ON sh.item_id = n.id WHERE sh.workspace_id = ? ORDER BY id'
        );
        assert.deepEqual(query.map(tables), [['notes n'], ['notes n', 'item_shares sh']]);
    });

    it('lit une table dérivée, et ses branches', () => {
        const [block] = select(
            'SELECT v.* FROM (SELECT p.* FROM projects p WHERE p.workspace_id = ? UNION SELECT p.* FROM projects p WHERE p.id = ?) v WHERE v.archived_at IS NULL'
        );
        assert.deepEqual(tables(block), ['(dérivée) v']);
        assert.deepEqual(block.refs[0].query?.map(tables), [['projects p'], ['projects p']]);
    });

    it('rattache une CTE à chacune de ses lectures', () => {
        const statement = readSql(
            'WITH mv AS (SELECT account_id AS acc FROM finance_transactions WHERE workspace_id = ?) SELECT a.id FROM finance_accounts a LEFT JOIN mv ON mv.acc = a.id WHERE a.workspace_id = ?'
        );
        assert.equal(statement.kind, 'select');
        if (statement.kind !== 'select') return;
        assert.equal(statement.ctes.length, 1);
        const mv = statement.query[0].refs[1];
        assert.equal(mv.table, null);
        assert.equal(mv.query, statement.ctes[0]);
    });
});

describe('readSql : les conditions', () => {
    const cond = (where: string): unknown =>
        shape(select(`SELECT 1 FROM t a JOIN u b ON b.t_id = a.id WHERE ${where}`)[0].cond);
    const where = (text: string): unknown => (cond(text) as { and: unknown[] }).and[1];

    it('garde la structure ET / OU, parenthèses comprises', () => {
        assert.deepEqual(where('a.id = ? AND (a.workspace_id = ? OR b.open = 1)'), {
            and: ['a.id = ?0', { or: ['a.workspace_id = ?1', 'b.open = constante'] }]
        });
    });

    it('ne coupe pas au AND d’un BETWEEN', () => {
        assert.deepEqual(where('a.ts BETWEEN ? AND ? AND a.workspace_id = ?'), {
            and: ['opaque', 'a.workspace_id = ?2']
        });
    });

    it('ne coupe pas dans un CASE', () => {
        assert.deepEqual(where('CASE WHEN a.x = 1 AND a.y = 2 THEN 1 ELSE 0 END = 1 AND a.workspace_id = ?'), {
            and: ['opaque', 'a.workspace_id = ?0']
        });
    });

    it('lit une liste de constantes comme une borne, et jamais un NOT IN', () => {
        assert.equal(where('a.workspace_id IN (?)'), 'a.workspace_id = constante');
        assert.equal(where('a.workspace_id IN (?, ?, 3)'), 'a.workspace_id = constante');
        assert.equal(where('a.workspace_id NOT IN (?)'), 'opaque');
    });

    it('tient une fonction de paramètres pour une constante, pas une fonction de colonne', () => {
        assert.equal(where('a.token_hash = UNHEX(?)'), 'a.token_hash = constante');
        assert.equal(where('a.name = LOWER(b.name)'), 'opaque');
    });

    it('lit la borne quel que soit le côté de l’égalité', () => {
        assert.equal(where('? = a.workspace_id'), 'a.workspace_id = ?0');
    });

    it('ne lit aucune borne dans une comparaison qui n’est pas une égalité', () => {
        assert.equal(where('a.workspace_id <> ?'), 'opaque');
        assert.equal(where('a.workspace_id >= ?'), 'opaque');
        assert.equal(where('a.workspace_id IS NOT NULL'), 'opaque');
    });

    it('lit EXISTS, IN (sous-requête) et = (sous-requête), et garde leurs requêtes', () => {
        const [block] = select(
            'SELECT 1 FROM notes n WHERE EXISTS (SELECT 1 FROM item_shares sh WHERE sh.item_id = n.id) AND n.folder_id IN (SELECT id FROM note_folders WHERE workspace_id = ?) AND n.user_id = (SELECT id FROM users WHERE email = ?)'
        );
        assert.deepEqual(shape(block.cond), {
            and: [
                {
                    and: [
                        { exists: [{ and: ['sh.item_id ~ n.id'] }] },
                        { in: 'n.folder_id', of: [['note_folders note_folders']] },
                        { in: 'n.user_id', of: [['users users']] }
                    ]
                }
            ]
        });
        assert.equal(block.nested.length, 3);
        assert.deepEqual(block.nested[1][0].first, { qualifier: null, name: 'id' });
    });

    it('garde les sous-requêtes d’une négation, sans rien en tirer', () => {
        const [block] = select(
            'SELECT 1 FROM notes n WHERE NOT EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id)'
        );
        assert.deepEqual(shape(block.cond), { and: ['opaque'] });
        assert.deepEqual(
            block.nested.map((q) => q.map(tables)),
            [[['note_tags t']]]
        );
    });

    it('garde les sous-requêtes de la liste rendue', () => {
        const [block] = select(
            'SELECT d.*, (SELECT COUNT(*) FROM database_alerts a WHERE a.database_id = d.id) AS alerts FROM database_connections d WHERE d.workspace_id = ?'
        );
        assert.deepEqual(
            block.nested.map((q) => q.map(tables)),
            [[['database_alerts a']]]
        );
    });
});

describe('readSql : les écritures', () => {
    it('lit la table et les colonnes d’une insertion', () => {
        const statement = readSql(
            'INSERT IGNORE INTO notes (workspace_id, `content`) VALUES (?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)'
        );
        assert.deepEqual(statement, {
            kind: 'insert',
            table: 'notes',
            columns: ['workspace_id', 'content'],
            select: null,
            nested: [],
            ctes: []
        });
    });

    it('lit la requête d’un INSERT … SELECT, sans son ON DUPLICATE', () => {
        const statement = readSql(
            'INSERT INTO note_tags (note_id, tag) SELECT n.id, ? FROM notes n JOIN note_folders f ON f.id = n.folder_id WHERE n.workspace_id = ? ON DUPLICATE KEY UPDATE tag = VALUES(tag)'
        );
        assert.equal(statement.kind, 'insert');
        if (statement.kind !== 'insert') return;
        assert.deepEqual(statement.select?.map(tables), [['notes n', 'note_folders f']]);
    });

    it('rend une insertion sans liste de colonnes comme telle', () => {
        const statement = readSql('REPLACE INTO sync_meta VALUES (?, ?)');
        assert.equal(statement.kind === 'insert' && statement.columns, null);
    });

    it('lit les tables et la condition d’un UPDATE à jointure', () => {
        const block = write(
            'UPDATE ft_invoicing_lines l JOIN ft_invoicing_docs d ON d.id = l.doc_id SET l.sort_order = ?, l.total = (SELECT 1 FROM dual) WHERE l.id = ? AND l.workspace_id = ? LIMIT 1'
        );
        assert.deepEqual(tables(block), ['ft_invoicing_lines l', 'ft_invoicing_docs d']);
        assert.deepEqual(shape(block.cond), {
            and: ['d.id ~ l.doc_id', { and: ['l.id = ?1', 'l.workspace_id = ?2'] }]
        });
        assert.equal(block.nested.length, 1);
    });

    it('lit un DELETE simple et un DELETE à alias', () => {
        assert.deepEqual(tables(write('DELETE FROM notes WHERE id = ? AND workspace_id = ?')), ['notes notes']);
        assert.deepEqual(
            tables(
                write(
                    'DELETE b FROM ft_mail_bodies b JOIN mail_messages m ON m.id = b.message_id WHERE m.folder_id = ?'
                )
            ),
            ['ft_mail_bodies b', 'mail_messages m']
        );
    });

    it('laisse de côté ce qui n’est ni lecture ni écriture de lignes', () => {
        assert.deepEqual(readSql('CREATE TABLE IF NOT EXISTS _migrations (name VARCHAR(255) PRIMARY KEY)'), {
            kind: 'other'
        });
    });
});

describe('readSql : ce qu’il ne lit pas', () => {
    for (const sql of [
        'SELECT * FROM a RIGHT JOIN b ON b.id = a.b_id',
        'SELECT * FROM a JOIN b USING (id)',
        'SELECT * FROM a NATURAL JOIN b',
        'INSERT INTO notes SET workspace_id = ?',
        'SELECT * FROM (a JOIN b ON b.id = a.b_id)',
        'SELECT * FROM notes WHERE (id = ?'
    ]) {
        it(`refuse « ${sql} »`, () => {
            assert.throws(() => readSql(sql), UnreadSql);
        });
    }
});
