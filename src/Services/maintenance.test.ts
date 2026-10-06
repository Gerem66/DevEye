import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { MAINTENANCE_CLOSE_CODE, MAINTENANCE_EVENT, type FeatureMaintenanceLevel } from '@deveye/types';

import type { Database } from '@/db';
import type { FeatureMaintenanceRow, SiteMaintenanceRow } from '@/db/repos/maintenance';
import type { LiveHub } from '@/live/hub';
import { attachPlanPauses, type PlanPauses } from '@/Services/planPauses';
import { env } from '@/Utils/Env';
import {
    DEFAULT_SITE_MESSAGE,
    FEATURE_MAINTENANCE_MESSAGE,
    FEATURE_PREVIEW_MESSAGE,
    maintenance,
    type MaintenanceServices
} from './maintenance';

const ADMIN = 1;
const MEMBER = 2;

/** La base, réduite aux deux tables et aux administrateurs. */
function fakeDb(rows: { site?: Partial<SiteMaintenanceRow>; features?: Record<string, FeatureMaintenanceLevel> } = {}) {
    const site: SiteMaintenanceRow = {
        active: false,
        message: null,
        envNoticeDismissed: false,
        updated: 0,
        updatedBy: null,
        priority: false,
        priorityUpdated: null,
        priorityBy: null,
        ...rows.site
    };
    const features = new Map(Object.entries(rows.features ?? {}));
    let seeded = 0;
    const db = {
        users: { listAdminIds: async () => [ADMIN] },
        maintenance: {
            site: async () => ({ ...site }),
            features: async (): Promise<FeatureMaintenanceRow[]> =>
                [...features].map(([feature, level]) => ({ feature, level, updated: 1, updatedBy: null })),
            setSite: async (active: boolean, message: string | null) => {
                site.active = active;
                site.message = message;
            },
            setPriority: async (active: boolean) => {
                site.priority = active;
            },
            seedFromEnv: async () => {
                seeded += 1;
                site.active = true;
                site.envNoticeDismissed = false;
            },
            dismissEnvNotice: async () => {
                site.envNoticeDismissed = true;
            },
            setFeature: async (feature: string, level: FeatureMaintenanceLevel | null) => {
                if (level === null) features.delete(feature);
                else features.set(feature, level);
            }
        }
    };
    return { db: db as unknown as Database, site, features, seeded: () => seeded };
}

function fakeLive() {
    const broadcasts: { command: string; data: unknown }[] = [];
    const closes: { refuse: (userId: number) => boolean; code: number }[] = [];
    const live = {
        broadcast: (command: string, data: unknown) => broadcasts.push({ command, data }),
        closeWhere: (refuse: (userId: number) => boolean, code: number) => closes.push({ refuse, code })
    };
    return { live: live as unknown as LiveHub, broadcasts, closes };
}

function fakeServices(delays: Record<string, number> = {}) {
    const calls: string[] = [];
    const services: MaintenanceServices = {
        installed: () => ['uptime', 'notes'],
        hasService: (id) => id === 'uptime',
        stop: async (id) => {
            calls.push(`stop:${id}`);
            await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 0));
            calls.push(`stopped:${id}`);
        },
        start: async (id) => {
            calls.push(`start:${id}`);
        }
    };
    return { services, calls };
}

const logger = { warn: () => undefined, error: () => undefined } as never;

async function boot(
    rows: Parameters<typeof fakeDb>[0] = {},
    delays: Record<string, number> = {}
): Promise<ReturnType<typeof fakeDb> & ReturnType<typeof fakeLive> & ReturnType<typeof fakeServices>> {
    const db = fakeDb(rows);
    const live = fakeLive();
    const services = fakeServices(delays);
    await maintenance.init({
        db: db.db,
        live: live.live,
        logger,
        services: services.services,
        hasPlanProvider: () => true
    });
    return { ...db, ...live, ...services };
}

const setEnv = (on: boolean): void => {
    (env as { MAINTENANCE: boolean }).MAINTENANCE = on;
};

afterEach(async () => {
    await maintenance.close();
    setEnv(false);
});

describe('maintenance : le démarrage', () => {
    it('lit la base sans rien diffuser ni arrêter', async () => {
        const t = await boot({ site: { active: true, message: 'Retour à midi' }, features: { uptime: 'full' } });
        assert.equal(maintenance.siteDown(), true);
        assert.equal(maintenance.message(), 'Retour à midi');
        assert.equal(maintenance.featureLevel('uptime'), 'full');
        assert.deepEqual(t.broadcasts, []);
        assert.deepEqual(t.calls, []);
    });

    it('sous MAINTENANCE=true, ferme le site et réarme le rappel', async () => {
        setEnv(true);
        const t = await boot({ site: { envNoticeDismissed: true } });
        assert.equal(t.seeded(), 1);
        assert.equal(maintenance.siteDown(), true);
        assert.equal(t.site.envNoticeDismissed, false);
    });

    it('sans la variable, ne touche pas à la base', async () => {
        const t = await boot();
        assert.equal(t.seeded(), 0);
        assert.equal(maintenance.siteDown(), false);
        assert.equal(maintenance.message(), DEFAULT_SITE_MESSAGE);
    });

    it("ignore la ligne d'un module qui n'est plus installé", async () => {
        await boot({ features: { 'x-retire': 'requests' } });
        assert.equal(maintenance.featureLevel('x-retire'), null);
        assert.deepEqual(maintenance.clientState().features, {});
    });
});

describe('maintenance : le site', () => {
    it('prévient tous les écrans, puis ferme les sockets des non-administrateurs', async () => {
        const t = await boot();
        await maintenance.setSite(true, null, ADMIN);
        assert.equal(maintenance.siteDown(), true);
        assert.equal(t.broadcasts.length, 1);
        assert.equal(t.broadcasts[0]?.command, MAINTENANCE_EVENT);
        assert.equal(t.closes.length, 1);
        assert.equal(t.closes[0]?.code, MAINTENANCE_CLOSE_CODE);
        assert.equal(t.closes[0]?.refuse(ADMIN), false);
        assert.equal(t.closes[0]?.refuse(MEMBER), true);
    });

    it('ne ferme rien à la levée, ni au changement du seul message', async () => {
        const t = await boot({ site: { active: true } });
        await maintenance.setSite(true, 'Nouveau texte', ADMIN);
        await maintenance.setSite(false, 'Nouveau texte', ADMIN);
        assert.equal(t.broadcasts.length, 2);
        assert.equal(t.closes.length, 0);
    });

    it('ne diffuse rien quand rien ne change', async () => {
        const t = await boot();
        await maintenance.setSite(false, null, ADMIN);
        assert.deepEqual(t.broadcasts, []);
    });
});

describe('maintenance : la priorité aux abonnés', () => {
    it('prévient tous les écrans et relance la passe des pauses, sans fermer aucune socket', async () => {
        let passes = 0;
        attachPlanPauses({ scheduleAll: () => void passes++ } as unknown as PlanPauses);
        try {
            const t = await boot();
            await maintenance.setPriority(true, ADMIN);
            assert.equal(maintenance.priority(), true);
            assert.equal((t.broadcasts[0]?.data as { priority: boolean }).priority, true);
            assert.equal(t.closes.length, 0);
            assert.equal(passes, 1);
            await maintenance.setPriority(true, ADMIN);
            assert.equal(passes, 1);
            await maintenance.setPriority(false, ADMIN);
            assert.equal(passes, 2);
        } finally {
            attachPlanPauses(null);
        }
    });
});

describe('maintenance : les features', () => {
    it("refuse le niveau Maintenance au seul non-administrateur, l'arrêt complet à tous", async () => {
        await boot({ features: { uptime: 'requests' } });
        assert.equal(maintenance.refuses('uptime', false), true);
        assert.equal(maintenance.refuses('uptime', true), false);
        await maintenance.setFeature('uptime', 'full', ADMIN);
        assert.equal(maintenance.refuses('uptime', true), true);
        assert.equal(maintenance.refuses('notes', false), false);
    });

    it("laisse passer les routes réservées à l'app, sauf à l'arrêt complet", async () => {
        await boot({ site: { active: true }, features: { uptime: 'requests' } });
        assert.equal(maintenance.refusesPublic('notes', false), true);
        assert.equal(maintenance.refusesPublic('notes', true), false);
        assert.equal(maintenance.refusesPublic('uptime', true), false);
        await maintenance.setFeature('uptime', 'full', ADMIN);
        assert.equal(maintenance.refusesPublic('uptime', true), true);
    });

    it('réserve la préversion aux administrateurs sans fermer ses routes publiques ni son service', async () => {
        const t = await boot({ features: { uptime: 'preview' } });
        assert.equal(maintenance.refuses('uptime', false), true);
        assert.equal(maintenance.refuses('uptime', true), false);
        assert.equal(maintenance.refusalMessage('uptime'), FEATURE_PREVIEW_MESSAGE);
        assert.equal(maintenance.refusesPublic('uptime', false), false);
        await maintenance.setFeature('uptime', 'requests', ADMIN);
        assert.equal(maintenance.refusalMessage('uptime'), FEATURE_MAINTENANCE_MESSAGE);
        assert.equal(maintenance.refusesPublic('uptime', false), true);
        await maintenance.setFeature('uptime', 'preview', ADMIN);
        assert.deepEqual(t.calls, []);
    });

    it("arrête le service à l'arrêt complet et le relance à la sortie, pas avant", async () => {
        const t = await boot();
        await maintenance.setFeature('uptime', 'requests', ADMIN);
        assert.deepEqual(t.calls, []);
        await maintenance.setFeature('uptime', 'full', ADMIN);
        await maintenance.setFeature('uptime', 'requests', ADMIN);
        assert.deepEqual(t.calls, ['stop:uptime', 'stopped:uptime', 'start:uptime']);
    });

    it("n'appelle rien pour une feature sans service", async () => {
        const t = await boot();
        await maintenance.setFeature('notes', 'full', ADMIN);
        await maintenance.setFeature('notes', null, ADMIN);
        assert.deepEqual(t.calls, []);
    });

    it("ne fait pas attendre la fermeture du site derrière l'arrêt lent d'un service", async () => {
        const t = await boot({}, { uptime: 50 });
        const stopping = maintenance.setFeature('uptime', 'full', ADMIN);
        await maintenance.setSite(true, null, ADMIN);
        assert.equal(maintenance.siteDown(), true);
        assert.deepEqual(t.calls, ['stop:uptime']);
        await stopping;
        assert.deepEqual(t.calls, ['stop:uptime', 'stopped:uptime']);
    });

    it("ne relance qu'après la fin de l'arrêt, même demandée pendant", async () => {
        const t = await boot({}, { uptime: 30 });
        await Promise.all([
            maintenance.setFeature('uptime', 'full', ADMIN),
            maintenance.setFeature('uptime', null, ADMIN)
        ]);
        assert.deepEqual(t.calls, ['stop:uptime', 'stopped:uptime', 'start:uptime']);
        assert.equal(maintenance.featureLevel('uptime'), null);
    });
});

describe('maintenance : le rappel de MAINTENANCE=true', () => {
    it("vaut tant qu'aucun administrateur ne l'a fermé", async () => {
        setEnv(true);
        await boot();
        assert.equal(await maintenance.envNotice(), true);
        await maintenance.dismissEnvNotice();
        assert.equal(await maintenance.envNotice(), false);
    });

    it('ne vaut rien sans la variable', async () => {
        await boot();
        assert.equal(await maintenance.envNotice(), false);
    });
});
