import {
    backupCount,
    backupDestinationAdd,
    backupDestinationList,
    backupDestinationRemove,
    backupDestinationTest,
    backupDestinationUpdate,
    backupJobAdd,
    backupJobGet,
    backupJobList,
    backupJobRemove,
    backupJobRun,
    backupJobUpdate,
    backupRuns,
    backupSources
} from '../contracts/commands';
import type { BackupSourceCandidate } from '../contracts/domain';

import { defineSdkFeature, FeatureError, type SdkFeatureDefinition } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : l'adresse du service S3
// est saisie par un membre.
import { isAllowedOutboundUrl, OUTBOUND_REFUSED_MESSAGE } from '@/Services/netFetch';
import type { BackupRepo } from './repo';
import { nextRunAt } from './schedule';
import { safeRelPath } from './sinks';
import {
    cloudSyncProvider,
    databaseProvider,
    loadDestination,
    loadHomeJob,
    loadJob,
    readJsonWith,
    requireEngine,
    toDestination,
    toJob,
    toRun,
    type Ctx,
    type StoredDestination,
    type StoredJob
} from './_shared';

/**
 * Sauvegardes : les destinations de l'espace et les travaux qui y écrivent.
 * Tout est à l'étage ouvert : aucune commande ne demande de session
 * déverrouillée.
 */

const destinationListFeature = defineSdkFeature({
    ...backupDestinationList,
    access: { level: 'read' },
    handler: async (ctx: Ctx) => {
        const rows = await ctx.repo.listDestinations(ctx.workspaceId);
        return { destinations: await Promise.all(rows.map((row) => toDestination(ctx, row))) };
    }
});

/**
 * Les champs obligatoires dépendent du genre, ce que le contrat zod n'exprime
 * pas sans imposer trois formulaires à l'écran.
 */
function assertDestinationShape(input: {
    kind: string;
    deviceId: string | null;
    path: string;
    endpoint: string | null;
    bucket: string | null;
    accessKeyId: string | null;
}): void {
    if (input.kind === 'device') {
        if (!input.deviceId)
            throw new FeatureError('validation', 'Choisissez la machine qui hébergera les sauvegardes.');
        const path = input.path.trim();
        if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
            throw new FeatureError('validation', 'Le dossier de la machine doit être un chemin absolu.');
        }
        if (path.includes('..')) {
            throw new FeatureError('validation', 'Le dossier de la machine ne peut pas contenir « .. ».');
        }
        return;
    }

    if (input.kind === 'local') {
        // Validé à l'enregistrement : découvrir un chemin refusé au premier
        // passage nocturne, c'est une nuit sans sauvegarde.
        try {
            safeRelPath(input.path);
        } catch (e) {
            throw new FeatureError('validation', (e as Error).message);
        }
        return;
    }

    if (!input.endpoint || !input.bucket || !input.accessKeyId) {
        throw new FeatureError('validation', 'Une destination S3 exige une adresse, un bucket et une clé d’accès.');
    }
    try {
        new URL(input.endpoint);
    } catch {
        throw new FeatureError('validation', 'L’adresse du service S3 doit être une URL complète (https://…).');
    }
    if (!isAllowedOutboundUrl(input.endpoint)) throw new FeatureError('validation', OUTBOUND_REFUSED_MESSAGE);
    if (input.path.includes('..')) {
        throw new FeatureError('validation', 'Le préfixe S3 ne peut pas contenir « .. ».');
    }
}

/** Sans ce contrôle, on écrirait des archives sur la machine d'un autre espace en devinant un identifiant. */
async function assertDeviceInWorkspace(ctx: Ctx, deviceId: string | null): Promise<void> {
    const devices = await ctx.deveye.devices.list();
    if (!devices.some((d) => d.id === deviceId)) {
        throw new FeatureError('not_found', "Cet appareil n'appartient pas à cet espace.");
    }
}

const destinationAddFeature = defineSdkFeature({
    ...backupDestinationAdd,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        assertDestinationShape(input);
        if (input.kind === 's3' && !input.secret) {
            throw new FeatureError('validation', 'Une destination S3 exige sa clé secrète.');
        }
        if (input.kind === 'device') await assertDeviceInWorkspace(ctx, input.deviceId);

        const stored: StoredDestination = {
            name: input.name,
            path: input.path,
            endpoint: input.endpoint,
            region: input.region,
            bucket: input.bucket,
            accessKeyId: input.accessKeyId,
            lastError: null
        };
        const cipher = ctx.cipher();
        const row = await ctx.repo.createDestination({
            workspaceId: ctx.workspaceId,
            kind: input.kind,
            deviceId: input.kind === 'device' ? input.deviceId : null,
            pathStyle: input.pathStyle,
            content: await cipher.encrypt(JSON.stringify(stored)),
            secretEnc: input.secret ? await cipher.encrypt(input.secret) : ''
        });

        ctx.audit({
            action: 'backup.destinationAdd',
            description: `Destination de sauvegarde « ${input.name} » (${input.kind}) ajoutée`,
            metadata: { destinationId: row.id, kind: input.kind }
        });

        const full = await ctx.repo.listDestinations(ctx.workspaceId);
        const created = full.find((d) => d.id === row.id);
        if (!created) throw new FeatureError('internal', 'Destination créée mais introuvable');
        return { destination: await toDestination(ctx, created) };
    }
});

const destinationUpdateFeature = defineSdkFeature({
    ...backupDestinationUpdate,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await loadDestination(ctx, input.destinationId);
        assertDestinationShape({ ...input, kind: row.kind });
        if (row.kind === 'device') await assertDeviceInWorkspace(ctx, input.deviceId);

        const stored: StoredDestination = {
            name: input.name,
            path: input.path,
            endpoint: input.endpoint,
            region: input.region,
            bucket: input.bucket,
            accessKeyId: input.accessKeyId,
            // Le verdict du dernier contrôle ne survit pas à une modification :
            // il portait sur une configuration qui n'existe plus.
            lastError: null
        };
        const cipher = ctx.cipher();
        const updated = await ctx.repo.updateDestination(input.destinationId, ctx.workspaceId, {
            deviceId: row.kind === 'device' ? input.deviceId : null,
            pathStyle: input.pathStyle,
            content: await cipher.encrypt(JSON.stringify(stored)),
            secretEnc: input.secret ? await cipher.encrypt(input.secret) : undefined
        });
        if (!updated) throw new FeatureError('not_found', 'Destination introuvable');

        ctx.audit({
            action: 'backup.destinationUpdate',
            description: `Destination de sauvegarde « ${input.name} » modifiée`,
            metadata: { destinationId: updated.id }
        });

        const full = await ctx.repo.listDestinations(ctx.workspaceId);
        const after = full.find((d) => d.id === updated.id);
        if (!after) throw new FeatureError('internal', 'Destination modifiée mais introuvable');
        return { destination: await toDestination(ctx, after) };
    }
});

const destinationRemoveFeature = defineSdkFeature({
    ...backupDestinationRemove,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        await loadDestination(ctx, input.destinationId);
        // Le refus se décide ici, en disant combien de travaux bloquent, plutôt
        // que de laisser la clé étrangère cascader en silence.
        const uses = await ctx.repo.countJobsUsing(input.destinationId);
        if (uses > 0) {
            throw new FeatureError(
                'conflict',
                `${uses} travail(aux) écrivent encore ici. Supprimez-les ou changez leur destination d’abord.`
            );
        }
        const ok = await ctx.repo.deleteDestination(input.destinationId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Destination introuvable');

        ctx.audit({
            action: 'backup.destinationRemove',
            level: 'warning',
            description: 'Destination de sauvegarde retirée',
            metadata: { destinationId: input.destinationId }
        });
        // Les archives déjà écrites ne sont pas touchées : ranger sa configuration ne détruit rien.
        return { destinationId: input.destinationId };
    }
});

const destinationTestFeature = defineSdkFeature({
    ...backupDestinationTest,
    access: { level: 'write' },
    // Écrit le verdict du contrôle sur la ligne : les autres écrans doivent le
    // voir sans recharger.
    mutates: true,
    handler: async (ctx: Ctx, input) =>
        requireEngine().probeDestination(await loadDestination(ctx, input.destinationId))
});

const jobListFeature = defineSdkFeature({
    ...backupJobList,
    access: { level: 'read' },
    handler: async (ctx: Ctx) => {
        const rows = await ctx.repo.listVisibleJobs(ctx.workspaceId);
        // Un travail masqué pour ce rôle disparaît de la liste plutôt que d'y figurer grisé.
        const hidden = await ctx.items.restrictions();
        const visible = rows.filter((r) => hidden.get(String(r.id)) !== 'none');
        const shares = await ctx.sharing.scope();
        return { jobs: await Promise.all(visible.map((row) => toJob(ctx, row, shares))) };
    }
});

const countFeature = defineSdkFeature({
    ...backupCount,
    access: { level: 'read' },
    handler: async (ctx: Ctx) => {
        // Les mêmes lignes que la liste, projetées comprises : la carte compte ce
        // que la liste montre.
        const rows = await ctx.repo.listVisibleJobs(ctx.workspaceId);
        const hidden = await ctx.items.restrictions();
        const visible = rows.filter((r) => hidden.get(String(r.id)) !== 'none' && r.enabled === 1);
        return {
            count: visible.length,
            failing: visible.filter((r) => r.last_status === 'failed').length
        };
    }
});

const jobGetFeature = defineSdkFeature({
    ...backupJobGet,
    access: { level: 'read' },
    handler: async (ctx: Ctx, input) => {
        const row = await ctx.repo.findVisibleJobWithState(input.jobId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');
        await ctx.items.assert(String(input.jobId));
        const shares = await ctx.sharing.scope();
        const cipher = await shares.cipherFor(String(row.id));
        // L'historique vit chez le travail : pour un projeté, le chercher ici
        // rendrait une fiche vide qu'on croirait jamais exécutée.
        const runs = await ctx.repo.listRuns(input.jobId, row.workspace_id, input.limit ?? 20);
        return {
            job: await toJob(ctx, row, shares),
            runs: await Promise.all(runs.map((r) => toRun(ctx, r, cipher)))
        };
    }
});

/**
 * La base de DevEye porte tous les comptes de l'instance : seul un
 * administrateur la sauvegarde, et depuis son espace personnel, où personne
 * d'autre ne peut détourner la destination de ses archives.
 */
function canBackupDevEye(ctx: Ctx): boolean {
    return ctx.isAdmin && ctx.workspace.kind === 'personal';
}

/** Vérifie que la source désignée existe **dans cet espace**. */
async function assertSource(ctx: Ctx, source: string, sourceId: number | null): Promise<void> {
    if (source === 'deveye') {
        if (!canBackupDevEye(ctx)) {
            throw new FeatureError(
                'forbidden',
                'La base de DevEye ne se sauvegarde que depuis l’espace personnel d’un administrateur.'
            );
        }
        return;
    }
    if (sourceId === null) throw new FeatureError('validation', 'Choisissez ce que ce travail doit sauvegarder.');

    if (source === 'database') {
        const databases = databaseProvider(ctx);
        if (!databases) throw new FeatureError('not_found', 'Les bases de données sont indisponibles.');
        if (!(await databases.findDatabase(sourceId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Cette base de données est introuvable dans cet espace.');
        }
        return;
    }
    const cloudSync = cloudSyncProvider(ctx);
    if (!cloudSync) throw new FeatureError('not_found', 'CloudSync est indisponible : module non installé.');
    const share = await cloudSync.findShare(sourceId);
    if (!share || share.workspaceId !== ctx.workspaceId) {
        throw new FeatureError('not_found', 'Ce partage CloudSync est introuvable dans cet espace.');
    }
}

const jobAddFeature = defineSdkFeature({
    ...backupJobAdd,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        await loadDestination(ctx, input.destinationId);
        await assertSource(ctx, input.source, input.sourceId);

        const row = await ctx.repo.createJob({
            workspaceId: ctx.workspaceId,
            destinationId: input.destinationId,
            sourceKind: input.source,
            sourceId: input.source === 'deveye' ? null : input.sourceId,
            enabled: input.enabled,
            scheduleKind: input.schedule,
            scheduleHour: input.scheduleHour,
            scheduleWeekday: input.scheduleWeekday,
            scheduleDay: input.scheduleDay,
            keepLast: input.keepLast,
            encryption: input.encryption,
            nextRunAt: nextRunAt(
                input.schedule,
                input.enabled,
                input.scheduleHour,
                input.scheduleWeekday,
                input.scheduleDay
            ),
            content: await ctx.cipher().encrypt(JSON.stringify({ name: input.name } satisfies StoredJob))
        });

        ctx.audit({
            action: 'backup.jobAdd',
            description: `Travail de sauvegarde « ${input.name} » créé`,
            metadata: { jobId: row.id, source: input.source, destinationId: input.destinationId }
        });

        const after = await ctx.repo.findJobWithState(row.id, ctx.workspaceId);
        if (!after) throw new FeatureError('internal', 'Travail créé mais introuvable');
        return { job: await toJob(ctx, after) };
    }
});

const jobUpdateFeature = defineSdkFeature({
    ...backupJobUpdate,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        // Domicile seulement : sa destination et sa source se choisissent parmi
        // les objets de SON espace, que la fenêtre ne voit pas.
        await loadHomeJob(ctx, input.jobId);
        await loadDestination(ctx, input.destinationId);
        await assertSource(ctx, input.source, input.sourceId);

        const row = await ctx.repo.updateJob(input.jobId, ctx.workspaceId, {
            destinationId: input.destinationId,
            sourceKind: input.source,
            sourceId: input.source === 'deveye' ? null : input.sourceId,
            enabled: input.enabled,
            scheduleKind: input.schedule,
            scheduleHour: input.scheduleHour,
            scheduleWeekday: input.scheduleWeekday,
            scheduleDay: input.scheduleDay,
            keepLast: input.keepLast,
            encryption: input.encryption,
            // Recalculée : changer l'heure sans déplacer l'échéance ferait partir
            // le travail à l'ancienne jusqu'au lendemain.
            nextRunAt: nextRunAt(
                input.schedule,
                input.enabled,
                input.scheduleHour,
                input.scheduleWeekday,
                input.scheduleDay
            ),
            content: await ctx.cipher().encrypt(JSON.stringify({ name: input.name } satisfies StoredJob))
        });
        if (!row) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');

        ctx.audit({
            action: 'backup.jobUpdate',
            description: `Travail de sauvegarde « ${input.name} » modifié`,
            metadata: { jobId: row.id }
        });

        const after = await ctx.repo.findJobWithState(row.id, ctx.workspaceId);
        if (!after) throw new FeatureError('internal', 'Travail modifié mais introuvable');
        return { job: await toJob(ctx, after) };
    }
});

const jobRemoveFeature = defineSdkFeature({
    ...backupJobRemove,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const job = await loadHomeJob(ctx, input.jobId);
        if (requireEngine().isRunning(job.id)) {
            throw new FeatureError('conflict', 'Une sauvegarde de ce travail est en cours. Réessayez ensuite.');
        }
        const ok = await ctx.repo.deleteJob(input.jobId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');
        // Projections, restrictions et route de notification ne tiennent à
        // aucune clé étrangère : sans ce ménage, elles s'appliqueraient au
        // prochain travail à hériter de l'identifiant.
        await ctx.items.forget(String(input.jobId));

        ctx.audit({
            action: 'backup.jobRemove',
            level: 'warning',
            description: 'Travail de sauvegarde supprimé',
            metadata: { jobId: input.jobId }
        });
        return { jobId: input.jobId };
    }
});

const jobRunFeature = defineSdkFeature({
    ...backupJobRun,
    // Écrit une exécution en base : les autres écrans doivent voir le travail
    // passer en « en cours » sans recharger.
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        // Permis depuis une fenêtre : le moteur lit tout depuis l'espace du
        // travail, jamais depuis celui de l'appelant.
        const engine = requireEngine();
        const job = await loadJob(ctx, input.jobId, 'write');
        const cipher = await (await ctx.sharing.scope()).cipherFor(String(job.id));
        const name = (await readJsonWith<StoredJob>(cipher, job.content)).name ?? 'Sauvegarde';
        let run;
        try {
            run = await engine.trigger(job, ctx.userId);
        } catch (e) {
            throw new FeatureError('conflict', (e as Error).message);
        }
        ctx.audit({
            action: 'backup.jobRun',
            description: `Sauvegarde « ${name} » déclenchée manuellement`,
            metadata: { jobId: job.id, runId: run.id }
        });
        return { run: await toRun(ctx, run, cipher) };
    }
});

const ENGINE_TAGS: Record<'mysql' | 'postgres', string> = { mysql: 'MySQL', postgres: 'PostgreSQL' };

const sourcesFeature = defineSdkFeature({
    ...backupSources,
    access: { level: 'read' },
    handler: async (ctx: Ctx) => {
        const candidates: BackupSourceCandidate[] = [];
        if (canBackupDevEye(ctx)) {
            candidates.push({
                kind: 'deveye',
                id: null,
                name: 'Base de DevEye',
                detail: 'Tout ce que DevEye garde en base, pour tous les comptes : notes, mots de passe, supervision, index CloudSync, projets.',
                tag: null,
                available: true,
                reason: null
            });
        }

        // Sans le contrat de Bases de données, la source disparaît du sélecteur.
        const databases = databaseProvider(ctx);
        for (const row of databases ? await databases.listDatabases(ctx.workspaceId) : []) {
            candidates.push({
                kind: 'database',
                id: row.id,
                name: row.name,
                detail: `${row.engine} : ${row.host} / ${row.database}`,
                tag: ENGINE_TAGS[row.engine],
                available: true,
                reason: null
            });
        }

        // Sans le module CloudSync, la source disparaît ; les travaux persistés
        // qui la visent échoueront au run avec un message clair.
        const cloudSync = cloudSyncProvider(ctx);
        const shares = cloudSync ? await cloudSync.listShares(ctx.workspaceId) : [];
        for (const share of shares) {
            const stats = await cloudSync!.statsByShare(share.id);
            const files = `${stats.fileCount.toLocaleString('fr-FR')} fichier${stats.fileCount > 1 ? 's' : ''}`;
            candidates.push({
                kind: 'cloudsync',
                id: share.id,
                name: share.name,
                detail: `${files} : les fichiers, pas leur index (celui-ci est dans la base de DevEye).`,
                tag: stats.fileCount > 0 ? files : 'vide',
                available: stats.fileCount > 0,
                reason: stats.fileCount > 0 ? null : 'Ce partage est vide.'
            });
        }

        return { candidates };
    }
});

const runsFeature = defineSdkFeature({
    ...backupRuns,
    access: { level: 'read' },
    handler: async (ctx: Ctx, input) => {
        const rows = await ctx.repo.listWorkspaceRuns(ctx.workspaceId, input.limit ?? 50);
        return { runs: await Promise.all(rows.map((row) => toRun(ctx, row))) };
    }
});

export const backupHandlers: ReadonlyArray<SdkFeatureDefinition<BackupRepo>> = [
    destinationListFeature,
    destinationAddFeature,
    destinationUpdateFeature,
    destinationRemoveFeature,
    destinationTestFeature,
    jobListFeature,
    countFeature,
    jobGetFeature,
    jobAddFeature,
    jobUpdateFeature,
    jobRemoveFeature,
    jobRunFeature,
    sourcesFeature,
    runsFeature
];
