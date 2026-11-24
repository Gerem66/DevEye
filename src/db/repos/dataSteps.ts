import type { Queryable } from '../pool';

/** Les étapes de données déjà jouées (`db/dataSteps.ts`), sous `<module>/<id>`. */
export interface DataStepsRepo {
    applied(): Promise<string[]>;
    record(name: string): Promise<void>;
}

export function dataStepsRepo(pool: Queryable): DataStepsRepo {
    return {
        async applied() {
            const r = await pool.query<{ name: string }>('SELECT name FROM _data_steps', []);
            return r.rows.map((row) => row.name);
        },
        async record(name) {
            await pool.query('INSERT INTO _data_steps (name) VALUES (?)', [name]);
        }
    };
}
