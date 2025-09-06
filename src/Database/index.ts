import SQL from '@/Services/SQL';
import { UsersTable } from './UsersTable';
import { WorkspacesTable } from './WorkspacesTable';
import { WorkspaceMembersTable } from './WorkspaceMembersTable';
import { LogsTable } from './LogsTable';

export class Database {
    sql: SQL;

    users: UsersTable;
    workspaces: WorkspacesTable;
    workspaceMembers: WorkspaceMembersTable;
    logs: LogsTable;

    constructor(sql: SQL) {
        this.sql = sql;

        this.users = new UsersTable(sql);
        this.workspaces = new WorkspacesTable(sql);
        this.workspaceMembers = new WorkspaceMembersTable(sql);
        this.logs = new LogsTable(sql);
    }
}
