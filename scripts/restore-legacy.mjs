/**
 * One-off legacy data restore (non-destructive).
 *
 * Reads the previous app's capitalized tables (Users, Workspaces,
 * WorkspaceMembers, _Passwords) and copies the rows into the new lowercase
 * schema (users, workspaces, workspace_members, passwords).
 *
 * - Only SELECTs from the old tables; never writes to them.
 * - Uses INSERT IGNORE + preserved primary keys, so it is idempotent.
 *
 * Run once with: node scripts/restore-legacy.mjs
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
    host: process.env.DB_HOSTNAME,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

async function count(table) {
    const [r] = await conn.query('SELECT COUNT(*) AS n FROM `' + table + '`');
    return r[0].n;
}

try {
    console.log('Before:', {
        users: await count('users'),
        workspaces: await count('workspaces'),
        workspace_members: await count('workspace_members'),
        passwords: await count('passwords')
    });

    // users (settings reset to [] to match the new string[] model)
    await conn.query(`
        INSERT IGNORE INTO users
            (id, email, username, password_hash, avatar, settings,
             default_workspace, default_feature, re_auth_interval, last_login, created)
        SELECT ID, Email, Username, Password, Avatar, JSON_ARRAY(),
               DefaultWorkspace, DefaultFeature, ReAuthInterval,
               COALESCE(UNIX_TIMESTAMP(LastLogin), 0), UNIX_TIMESTAMP(Created)
        FROM Users
    `);

    // workspaces
    await conn.query(`
        INSERT IGNORE INTO workspaces
            (id, name, logo, features, password_hash, re_auth_interval, created)
        SELECT ID, Name, Logo, CAST(Features AS JSON), Password, ReAuthInterval,
               UNIX_TIMESTAMP(Created)
        FROM Workspaces
    `);

    // workspace_members
    await conn.query(`
        INSERT IGNORE INTO workspace_members
            (id, user_id, workspace_id, roles, date)
        SELECT ID, UserID, WorkspaceID, CAST(Roles AS JSON), UNIX_TIMESTAMP(Date)
        FROM WorkspaceMembers
    `);

    // passwords
    await conn.query(`
        INSERT IGNORE INTO passwords
            (id, user_id, workspace_id, content, date)
        SELECT ID, UserID, WorkspaceID, Content, UNIX_TIMESTAMP(Date)
        FROM _Passwords
    `);

    // personal workspace features: old Users.Features holds the feature list of
    // each user's private workspace (surfaced as workspace id 0). Copy it onto the
    // new users.features column. Read-only on the old `Users` table.
    const [pf] = await conn.query(`
        UPDATE users u
        JOIN Users o ON o.ID = u.id
        SET u.features = COALESCE(CAST(o.Features AS JSON), JSON_ARRAY())
    `);
    console.log('Personal features copied for', pf.affectedRows, 'user(s).');

    console.log('After:', {
        users: await count('users'),
        workspaces: await count('workspaces'),
        workspace_members: await count('workspace_members'),
        passwords: await count('passwords')
    });
    console.log('Legacy restore complete.');
} finally {
    await conn.end();
}
