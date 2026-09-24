import type { FeatureMaintenanceLevel } from '@deveye/types';
import type { Queryable } from '../pool';

interface Author {
    id: number;
    username: string;
}

export interface SiteMaintenanceRow {
    active: boolean;
    message: string | null;
    envNoticeDismissed: boolean;
    updated: number;
    updatedBy: Author | null;
}

export interface FeatureMaintenanceRow {
    feature: string;
    level: FeatureMaintenanceLevel;
    updated: number;
    updatedBy: Author | null;
}

export interface MaintenanceRepo {
    site(): Promise<SiteMaintenanceRow>;
    features(): Promise<FeatureMaintenanceRow[]>;
    setSite(active: boolean, message: string | null, by: number): Promise<void>;
    /** Le démarrage sous `MAINTENANCE=1` : le site fermé, et le rappel réarmé. */
    seedFromEnv(): Promise<void>;
    dismissEnvNotice(): Promise<void>;
    /** `null` rouvre la feature. */
    setFeature(feature: string, level: FeatureMaintenanceLevel | null, by: number): Promise<void>;
}

type RawAuthor = { updated_by: number | null; username: string | null };

const author = (row: RawAuthor): Author | null =>
    row.updated_by !== null && row.username !== null ? { id: row.updated_by, username: row.username } : null;

export function maintenanceRepo(pool: Queryable): MaintenanceRepo {
    return {
        async site() {
            const r = await pool.query<
                RawAuthor & { active: number; message: string | null; env_notice_dismissed: number; updated: number }
            >(
                `SELECT m.active, m.message, m.env_notice_dismissed, m.updated, m.updated_by, u.username
                 FROM site_maintenance m LEFT JOIN users u ON u.id = m.updated_by WHERE m.id = 1`
            );
            const row = r.rows[0];
            // Une ligne supprimée à la main vaut un site ouvert.
            if (!row) return { active: false, message: null, envNoticeDismissed: false, updated: 0, updatedBy: null };
            return {
                active: Number(row.active) === 1,
                message: row.message,
                envNoticeDismissed: Number(row.env_notice_dismissed) === 1,
                updated: Number(row.updated),
                updatedBy: author(row)
            };
        },
        async features() {
            const r = await pool.query<
                RawAuthor & { feature: string; level: FeatureMaintenanceLevel; updated: number }
            >(
                `SELECT m.feature, m.level, m.updated, m.updated_by, u.username
                 FROM feature_maintenance m LEFT JOIN users u ON u.id = m.updated_by`
            );
            return r.rows.map((row) => ({
                feature: row.feature,
                level: row.level,
                updated: Number(row.updated),
                updatedBy: author(row)
            }));
        },
        async setSite(active, message, by) {
            await pool.query(
                `INSERT INTO site_maintenance (id, active, message, updated, updated_by)
                 VALUES (1, ?, ?, UNIX_TIMESTAMP(), ?)
                 ON DUPLICATE KEY UPDATE active = VALUES(active), message = VALUES(message),
                     updated = VALUES(updated), updated_by = VALUES(updated_by)`,
                [active ? 1 : 0, message, by]
            );
        },
        async seedFromEnv() {
            await pool.query(
                `INSERT INTO site_maintenance (id, active, env_notice_dismissed, updated, updated_by)
                 VALUES (1, 1, 0, UNIX_TIMESTAMP(), NULL)
                 ON DUPLICATE KEY UPDATE active = 1, env_notice_dismissed = 0,
                     updated = VALUES(updated), updated_by = NULL`
            );
        },
        async dismissEnvNotice() {
            await pool.query('UPDATE site_maintenance SET env_notice_dismissed = 1 WHERE id = 1');
        },
        async setFeature(feature, level, by) {
            if (level === null) {
                await pool.query('DELETE FROM feature_maintenance WHERE feature = ?', [feature]);
                return;
            }
            await pool.query(
                `INSERT INTO feature_maintenance (feature, level, updated, updated_by)
                 VALUES (?, ?, UNIX_TIMESTAMP(), ?)
                 ON DUPLICATE KEY UPDATE level = VALUES(level), updated = VALUES(updated),
                     updated_by = VALUES(updated_by)`,
                [feature, level, by]
            );
        }
    };
}
