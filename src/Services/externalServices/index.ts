import { externalServiceSchema, type ExternalService } from '@deveye/types';

import type { Database } from '@/db';
import { moduleExternalServices } from '@/features/_sdk/register';
import { logger } from '@/logger';

import { hostServices } from './host';

/** Le temps laissé à chaque lecture : au-delà, la carte dit que le service ne répond pas. */
export const EXTERNAL_SERVICE_MS = 8_000;
/** La page se rouvre souvent : la même mesure sert quelques minutes, sauf demande expresse. */
const MEMO_MS = 5 * 60_000;

function withDeadline<T>(work: Promise<T>, late: () => T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(late()), EXTERNAL_SERVICE_MS);
        timer.unref();
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

const silent = (id: string, name: string): ExternalService => ({
    id,
    name,
    state: 'down',
    summary: `Pas de réponse en ${EXTERNAL_SERVICE_MS / 1000} s.`
});

async function readModule(
    entry: ReturnType<typeof moduleExternalServices>[number],
    refresh: boolean
): Promise<ExternalService[]> {
    const broken = (): ExternalService[] => [
        { id: `${entry.featureId}:error`, name: entry.label, state: 'down', summary: 'Lecture impossible.' }
    ];
    try {
        const read = await withDeadline(entry.read(refresh), () => [silent('timeout', entry.label)]);
        const parsed = externalServiceSchema.array().safeParse(read);
        if (!parsed.success) {
            logger.error({ module: entry.featureId, err: parsed.error.message }, 'Services externes mal formés');
            return broken();
        }
        return parsed.data.map((s) => ({ ...s, id: `${entry.featureId}:${s.id}` }));
    } catch (e) {
        logger.error({ module: entry.featureId, err: e }, 'Lecture des services externes en échec');
        return broken();
    }
}

let memo: { at: number; services: ExternalService[] } | null = null;
let running: Promise<{ at: number; services: ExternalService[] }> | null = null;

async function collect(db: Database, refresh: boolean): Promise<{ at: number; services: ExternalService[] }> {
    const host = hostServices(refresh).map(({ base, read }) =>
        withDeadline(
            read.catch((e): ExternalService => {
                logger.error({ service: base.id, err: e }, 'Sonde de service externe en échec');
                return { ...base, state: 'down', summary: 'Lecture impossible.' };
            }),
            () => silent(base.id, base.name)
        )
    );
    const modules = moduleExternalServices(db).map((entry) => readModule(entry, refresh));
    const [own, theirs] = await Promise.all([Promise.all(host), Promise.all(modules)]);
    return { at: Date.now(), services: [...own, ...theirs.flat()] };
}

/** Tous les services externes de l'instance, l'hôte d'abord puis chaque module, mesurés en parallèle. */
export async function externalServices(
    db: Database,
    refresh: boolean
): Promise<{ at: number; services: ExternalService[] }> {
    if (!refresh && memo && Date.now() - memo.at < MEMO_MS) return memo;
    running ??= collect(db, refresh).finally(() => {
        running = null;
    });
    memo = await running;
    return memo;
}
