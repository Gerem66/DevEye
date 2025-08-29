import { Pool } from 'mysql2/promise';

export interface IPool {
    name: string;
    pool: Pool;
}

export type IPoolOptional = {
    name: string;
    pool?: Pool;
};
