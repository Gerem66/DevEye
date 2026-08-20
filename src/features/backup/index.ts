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
    backupSources,
    type BackupSourceCandidate
} from 'deveye-types';

import { BackupService, type StoredDestination, type StoredJob } from '@/Services/BackupService';
import { safeRelPath } from '@/backup/sinks';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { shareScope } from '../_sharing';
import {
    backupService,
    loadDestination,
    loadHomeJob,
    loadJob,
    readJson,
    readJsonWith,
    READ,
    toDestination,
    toJob,
    toRun,
    WRITE
} from './_shared';

/**
 * Sauvegardes — les destinations de l'espace et les travaux qui y écrivent.
 *
 * Feature d'espace de premier rang, comme Git, Bases de données, Déploiement et
 * Audience. Une destination appartient à l'espace, pas à ce qu'elle sauvegarde :
 * le même Raspberry Pi reçoit le vidage d'une base **et** l'archive d'un partage
 * CloudSync sans qu'on ait à déclarer son chemin deux fois.
 *
 * Aucune de ces commandes ne demande de session déverrouillée : tout est à
 * l'étage ouvert, faute de quoi rien ne pourrait partir la nuit.
 */

// ---------------------------------------------------------- destinations

const destinationListFeature = defineFeature({
    ...backupDestinationList,
    access: READ,
    handler: async (ctx) => {
        const rows = await ctx.db.backup.listDestinations(ctx.workspaceId);
        return { destinations: await Promise.all(rows.map((row) => toDestination(ctx, row))) };
    }
});

/**
 * Valide la cohérence d'une destination **avant** de l'écrire.
 *
 * Le contrat zod ne peut pas l'exprimer : les champs obligatoires dépendent du
 * genre, et une union discriminée aurait imposé trois formulaires à l'écran là
 * où il n'y en a qu'un dont les champs apparaissent. La règle vit donc ici,
 * énoncée une fois, et rend une phrase que l'utilisateur peut corriger.
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
        // Validé à l'enregistrement et pas seulement à l'écriture : découvrir un
        // chemin refusé au premier passage nocturne, c'est une nuit sans
        // sauvegarde pour une faute de frappe.
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
    if (input.path.includes('..')) {
        throw new FeatureError('validation', 'Le préfixe S3 ne peut pas contenir « .. ».');
    }
}

const destinationAddFeature = defineFeature({
    ...backupDestinationAdd,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        assertDestinationShape(input);
        if (input.kind === 's3' && !input.secret) {
            throw new FeatureError('validation', 'Une destination S3 exige sa clé secrète.');
        }
        if (input.kind === 'device') {
            // L'appartenance de l'appareil à l'espace est vérifiée ici et pas
            // ailleurs : sans ce contrôle, on pourrait écrire des archives sur
            // la machine d'un autre espace en devinant un identifiant.
            const shared = await ctx.db.devices.listByWorkspace(ctx.workspaceId);
            if (!shared.some((d) => d.id === input.deviceId)) {
                throw new FeatureError('not_found', "Cet appareil n'appartient pas à cet espace.");
            }
        }

        const stored: StoredDestination = {
            name: input.name,
            path: input.path,
            endpoint: input.endpoint,
            region: input.region,
            bucket: input.bucket,
            accessKeyId: input.accessKeyId,
            lastError: null
        };
        const row = await ctx.db.backup.createDestination({
            workspaceId: ctx.workspaceId,
            kind: input.kind,
            deviceId: input.kind === 'device' ? input.deviceId : null,
            pathStyle: input.pathStyle,
            encrypt: input.encrypt,
            content: await ctx.secure.open.encrypt(JSON.stringify(stored)),
            secretEnc: input.secret ? await ctx.secure.open.encrypt(input.secret) : ''
        });

        ctx.audit({
            action: 'backup.destinationAdd',
            description: `Destination de sauvegarde « ${input.name} » (${input.kind}) ajoutée`,
            metadata: { destinationId: row.id, kind: input.kind }
        });

        const full = await ctx.db.backup.listDestinations(ctx.workspaceId);
        const created = full.find((d) => d.id === row.id);
        if (!created) throw new FeatureError('internal', 'Destination créée mais introuvable');
        return { destination: await toDestination(ctx, created) };
    }
});

const destinationUpdateFeature = defineFeature({
    ...backupDestinationUpdate,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await loadDestination(ctx, input.destinationId);
        assertDestinationShape({ ...input, kind: row.kind });

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
        const updated = await ctx.db.backup.updateDestination(input.destinationId, ctx.workspaceId, {
            deviceId: row.kind === 'device' ? input.deviceId : null,
            pathStyle: input.pathStyle,
            encrypt: input.encrypt,
            content: await ctx.secure.open.encrypt(JSON.stringify(stored)),
            secretEnc: input.secret ? await ctx.secure.open.encrypt(input.secret) : undefined
        });
        if (!updated) throw new FeatureError('not_found', 'Destination introuvable');

        ctx.audit({
            action: 'backup.destinationUpdate',
            description: `Destination de sauvegarde « ${input.name} » modifiée`,
            metadata: { destinationId: updated.id }
        });

        const full = await ctx.db.backup.listDestinations(ctx.workspaceId);
        const after = full.find((d) => d.id === updated.id);
        if (!after) throw new FeatureError('internal', 'Destination modifiée mais introuvable');
        return { destination: await toDestination(ctx, after) };
    }
});

const destinationRemoveFeature = defineFeature({
    ...backupDestinationRemove,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        await loadDestination(ctx, input.destinationId);
        // La clé étrangère est en RESTRICT, mais la refuser ici permet de dire
        // *combien* de travaux bloquent plutôt que de laisser remonter une
        // erreur SQL que personne ne peut corriger à l'écran.
        const uses = await ctx.db.backup.countJobsUsing(input.destinationId);
        if (uses > 0) {
            throw new FeatureError(
                'conflict',
                `${uses} travail(aux) écrivent encore ici. Supprimez-les ou changez leur destination d’abord.`
            );
        }
        const ok = await ctx.db.backup.deleteDestination(input.destinationId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Destination introuvable');

        ctx.audit({
            action: 'backup.destinationRemove',
            level: 'warning',
            description: 'Destination de sauvegarde retirée',
            metadata: { destinationId: input.destinationId }
        });
        // Les archives déjà écrites ne sont pas touchées : DevEye a produit des
        // fichiers chez quelqu'un d'autre, et ranger sa configuration ne doit
        // jamais les détruire.
        return { destinationId: input.destinationId };
    }
});

const destinationTestFeature = defineFeature({
    ...backupDestinationTest,
    access: WRITE,
    // Écrit le verdict du contrôle sur la ligne : les autres écrans doivent le
    // voir sans recharger.
    mutates: true,
    handler: async (ctx, input) => backupService(ctx).probeDestination(await loadDestination(ctx, input.destinationId))
});

// ---------------------------------------------------------------- travaux

const jobListFeature = defineFeature({
    ...backupJobList,
    access: READ,
    handler: async (ctx) => {
        const rows = await ctx.db.backup.listVisibleJobs(ctx.workspaceId);
        // Les travaux qu'une restriction masque pour ce rôle disparaissent de
        // la liste plutôt que d'y figurer grisés.
        const hidden = await ctx.itemRestrictions('backup');
        const visible = rows.filter((r) => hidden.get(r.id) !== 'none');
        const shares = await shareScope(ctx, 'backup');
        return { jobs: await Promise.all(visible.map((row) => toJob(ctx, row, shares))) };
    }
});

const countFeature = defineFeature({
    ...backupCount,
    access: READ,
    handler: async (ctx) => ctx.db.backup.countJobs(ctx.workspaceId)
});

const jobGetFeature = defineFeature({
    ...backupJobGet,
    access: READ,
    handler: async (ctx, input) => {
        const row = await ctx.db.backup.findVisibleJobWithState(input.jobId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');
        await ctx.assertItem('backup', input.jobId);
        const shares = await shareScope(ctx, 'backup');
        const cipher = await shares.cipherFor(row.id);
        // L'historique vit chez le travail : pour un projeté, le chercher ici
        // rendrait une fiche vide qu'on croirait jamais exécutée.
        const runs = await ctx.db.backup.listRuns(input.jobId, row.workspace_id, input.limit ?? 20);
        return {
            job: await toJob(ctx, row, shares),
            runs: await Promise.all(runs.map((r) => toRun(ctx, r, cipher)))
        };
    }
});

/** Vérifie que la source désignée existe **dans cet espace**. */
async function assertSource(ctx: FeatureContext, source: string, sourceId: number | null): Promise<void> {
    if (source === 'deveye') return;
    if (sourceId === null) throw new FeatureError('validation', 'Choisissez ce que ce travail doit sauvegarder.');

    if (source === 'database') {
        if (!(await ctx.db.databases.find(sourceId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Cette base de données est introuvable dans cet espace.');
        }
        return;
    }
    const share = await ctx.db.syncShares.findById(sourceId);
    if (!share || share.workspace_id !== ctx.workspaceId) {
        throw new FeatureError('not_found', 'Ce partage CloudSync est introuvable dans cet espace.');
    }
}

const jobAddFeature = defineFeature({
    ...backupJobAdd,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        await loadDestination(ctx, input.destinationId);
        await assertSource(ctx, input.source, input.sourceId);

        const row = await ctx.db.backup.createJob({
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
            nextRunAt: BackupService.nextRunAt(
                input.schedule,
                input.enabled,
                input.scheduleHour,
                input.scheduleWeekday,
                input.scheduleDay
            ),
            content: await ctx.secure.open.encrypt(JSON.stringify({ name: input.name } satisfies StoredJob))
        });

        ctx.audit({
            action: 'backup.jobAdd',
            description: `Travail de sauvegarde « ${input.name} » créé`,
            metadata: { jobId: row.id, source: input.source, destinationId: input.destinationId }
        });

        const after = await ctx.db.backup.findJobWithState(row.id, ctx.workspaceId);
        if (!after) throw new FeatureError('internal', 'Travail créé mais introuvable');
        return { job: await toJob(ctx, after) };
    }
});

const jobUpdateFeature = defineFeature({
    ...backupJobUpdate,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        // Domicile seulement : sa destination et sa source se choisissent parmi
        // les objets de SON espace, que la fenêtre ne voit pas.
        await loadHomeJob(ctx, input.jobId);
        await loadDestination(ctx, input.destinationId);
        await assertSource(ctx, input.source, input.sourceId);

        const row = await ctx.db.backup.updateJob(input.jobId, ctx.workspaceId, {
            destinationId: input.destinationId,
            sourceKind: input.source,
            sourceId: input.source === 'deveye' ? null : input.sourceId,
            enabled: input.enabled,
            scheduleKind: input.schedule,
            scheduleHour: input.scheduleHour,
            scheduleWeekday: input.scheduleWeekday,
            scheduleDay: input.scheduleDay,
            keepLast: input.keepLast,
            // Recalculée à chaque modification : changer l'heure sans déplacer
            // l'échéance laisserait le travail partir à l'ancienne jusqu'au
            // lendemain, ce que personne n'attend.
            nextRunAt: BackupService.nextRunAt(
                input.schedule,
                input.enabled,
                input.scheduleHour,
                input.scheduleWeekday,
                input.scheduleDay
            ),
            content: await ctx.secure.open.encrypt(JSON.stringify({ name: input.name } satisfies StoredJob))
        });
        if (!row) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');

        ctx.audit({
            action: 'backup.jobUpdate',
            description: `Travail de sauvegarde « ${input.name} » modifié`,
            metadata: { jobId: row.id }
        });

        const after = await ctx.db.backup.findJobWithState(row.id, ctx.workspaceId);
        if (!after) throw new FeatureError('internal', 'Travail modifié mais introuvable');
        return { job: await toJob(ctx, after) };
    }
});

const jobRemoveFeature = defineFeature({
    ...backupJobRemove,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const job = await loadHomeJob(ctx, input.jobId);
        if (backupService(ctx).isRunning(job.id)) {
            throw new FeatureError('conflict', 'Une sauvegarde de ce travail est en cours. Réessayez ensuite.');
        }
        const ok = await ctx.db.backup.deleteJob(input.jobId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');
        // Projections et restrictions ne tiennent à aucune clé étrangère : sans
        // ce ménage, elles s'appliqueraient au prochain travail à hériter de
        // l'identifiant.
        await ctx.db.itemSharing.forgetItem('backup', input.jobId, ctx.workspaceId);

        ctx.audit({
            action: 'backup.jobRemove',
            level: 'warning',
            description: 'Travail de sauvegarde supprimé',
            metadata: { jobId: input.jobId }
        });
        return { jobId: input.jobId };
    }
});

const jobRunFeature = defineFeature({
    ...backupJobRun,
    // Écrit une exécution en base : les autres écrans doivent voir le travail
    // passer en « en cours » sans recharger.
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Déclencher depuis une fenêtre est permis : le moteur lit tout — clé,
        // destination, historique — depuis l'espace du travail (`job.workspace_id`),
        // jamais depuis l'espace de l'appelant.
        const job = await loadJob(ctx, input.jobId, 'write');
        const cipher = await (await shareScope(ctx, 'backup')).cipherFor(job.id);
        const name = (await readJsonWith<StoredJob>(cipher, job.content)).name ?? 'Sauvegarde';
        let run;
        try {
            run = await backupService(ctx).trigger(job, ctx.userId);
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

const sourcesFeature = defineFeature({
    ...backupSources,
    access: READ,
    handler: async (ctx) => {
        const candidates: BackupSourceCandidate[] = [
            {
                kind: 'deveye',
                id: null,
                name: 'Base de DevEye',
                detail: 'Tout ce que DevEye garde en base : notes, mots de passe, supervision, index CloudSync, projets.',
                available: true,
                reason: null
            }
        ];

        const databases = await ctx.db.databases.list(ctx.workspaceId);
        for (const row of databases) {
            const stored = await readJson<{ name: string; host: string; database: string }>(ctx, row.content);
            candidates.push({
                kind: 'database',
                id: row.id,
                name: stored.name ?? `Base ${row.id}`,
                detail: `${row.engine} — ${stored.host ?? '?'} / ${stored.database ?? '?'}`,
                available: true,
                reason: null
            });
        }

        const shares = await ctx.db.syncShares.listByWorkspace(ctx.workspaceId);
        for (const share of shares) {
            const stats = await ctx.db.syncFiles.statsByShare(share.id);
            candidates.push({
                kind: 'cloudsync',
                id: share.id,
                name: share.name,
                detail: `${stats.fileCount} fichier(s) — les fichiers, pas leur index (celui-ci est dans la base de DevEye).`,
                available: stats.fileCount > 0,
                reason: stats.fileCount > 0 ? null : 'Ce partage est vide.'
            });
        }

        return { candidates };
    }
});

const runsFeature = defineFeature({
    ...backupRuns,
    access: READ,
    handler: async (ctx, input) => {
        const rows = await ctx.db.backup.listWorkspaceRuns(ctx.workspaceId, input.limit ?? 50);
        return { runs: await Promise.all(rows.map((row) => toRun(ctx, row))) };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const backupFeatures: FeatureDefinition<string, any, any>[] = [
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
