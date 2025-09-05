import SQL from '@/Services/SQL';
import { UsersTable } from './UsersTable';
import { ContextsTable } from './ContextsTable';
import { ContextsLinksTable } from './ContextsLinksTable';
import { LogsTable } from './LogsTable';

export class Database {
    sql: SQL;

    users: UsersTable;
    contexts: ContextsTable;
    contextsLinks: ContextsLinksTable;
    logs: LogsTable;

    constructor(sql: SQL) {
        this.sql = sql;

        this.users = new UsersTable(sql);
        this.contexts = new ContextsTable(sql);
        this.contextsLinks = new ContextsLinksTable(sql);
        this.logs = new LogsTable(sql);
    }
}
