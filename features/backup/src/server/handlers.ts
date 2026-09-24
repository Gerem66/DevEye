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
import type {
    BackupDestinationKind,
    BackupFolder,
    BackupSftpAuth,
    BackupSourceCandidate,
    BackupSourceKind
} from '../contracts/domain';

import { AGENT_FOLDER_ARCHIVE_PROBE, pathExclusionProblem } from '@deveye/types';
import {
    defineSdkFeature,
    FeatureError,
    isSafePublicUrl,
    type SdkDevice,
    type SdkFeatureDefinition
} from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : l'adresse d'un service
// S3 ou WebDAV est saisie par un membre.
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
    readJson,
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

/** Ce que le formulaire envoie, tous genres confondus. */
interface DestinationInput {
    name: string;
    deviceId: string | null;
    path: string;
    endpoint: string | null;
    region: string | null;
    bucket: string | null;
    accessKeyId: string | null;
    host: string | null;
    port: number | null;
    username: string | null;
    sftpAuth: BackupSftpAuth | null;
}

/** Un chemin distant qui remonte au-dessus de son dossier. */
const climbs = (path: string): boolean => path.split(/[\\/]/).some((s) => s.trim() === '..');

/**
 * Les champs obligatoires dépendent du genre, ce que le contrat zod n'exprime
 * pas sans imposer un formulaire par genre à l'écran.
 */
function assertDestinationShape(kind: BackupDestinationKind, input: DestinationInput): void {
    switch (kind) {
        case 'device': {
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

        case 'local':
            // Validé à l'enregistrement : découvrir un chemin refusé au premier
            // passage nocturne, c'est une nuit sans sauvegarde.
            try {
                safeRelPath(input.path);
            } catch (e) {
                throw new FeatureError('validation', (e as Error).message);
            }
            return;

        case 's3':
            if (!input.endpoint || !input.bucket || !input.accessKeyId) {
                throw new FeatureError(
                    'validation',
                    'Une destination S3 exige une adresse, un bucket et une clé d’accès.'
                );
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
            return;

        case 'sftp': {
            const host = input.host?.trim() ?? '';
            if (!host || !input.username?.trim() || !input.sftpAuth) {
                throw new FeatureError(
                    'validation',
                    'Une destination SFTP exige un hôte, un identifiant et une façon de se connecter.'
                );
            }
            if (!/^[A-Za-z0-9._:[\]-]+$/.test(host)) {
                throw new FeatureError(
                    'validation',
                    'L’hôte SFTP est un nom ou une adresse, sans « sftp:// » ni chemin.'
                );
            }
            if (climbs(input.path)) {
                throw new FeatureError('validation', 'Le dossier SFTP ne peut pas contenir « .. ».');
            }
            return;
        }

        case 'webdav': {
            if (!input.endpoint || !input.username?.trim()) {
                throw new FeatureError('validation', 'Une destination WebDAV exige une adresse et un identifiant.');
            }
            let url: URL;
            try {
                url = new URL(input.endpoint);
            } catch {
                throw new FeatureError('validation', 'L’adresse WebDAV doit être une URL complète (https://…).');
            }
            if (!isAllowedOutboundUrl(url)) throw new FeatureError('validation', OUTBOUND_REFUSED_MESSAGE);
            // En http, le mot de passe voyage en clair : permis seulement vers une
            // adresse privée, qu'une installation personnelle ouvre elle-même.
            if (url.protocol === 'http:' && isSafePublicUrl(url)) {
                throw new FeatureError(
                    'validation',
                    'En http, le mot de passe partirait en clair sur Internet : utilisez une adresse https.'
                );
            }
            if (url.username || url.password) {
                throw new FeatureError(
                    'validation',
                    'L’identifiant et le mot de passe vont dans leurs champs, pas dans l’adresse.'
                );
            }
            if (climbs(input.path)) {
                throw new FeatureError('validation', 'Le dossier WebDAV ne peut pas contenir « .. ».');
            }
            return;
        }

        default: {
            const unknown: never = kind;
            throw new FeatureError('validation', `Genre de destination inconnu : ${String(unknown)}`);
        }
    }
}

/** Le contenu chiffré d'une destination : seuls les champs de son genre y entrent. */
function storedFrom(kind: BackupDestinationKind, input: DestinationInput, hostKey: string | null): StoredDestination {
    return {
        name: input.name,
        path: input.path.trim(),
        endpoint: kind === 's3' || kind === 'webdav' ? (input.endpoint?.trim() ?? null) : null,
        region: kind === 's3' ? input.region : null,
        bucket: kind === 's3' ? input.bucket : null,
        accessKeyId: kind === 's3' ? input.accessKeyId : null,
        host: kind === 'sftp' ? (input.host?.trim() ?? null) : null,
        port: kind === 'sftp' ? (input.port ?? 22) : null,
        username: kind === 'sftp' || kind === 'webdav' ? (input.username?.trim() ?? null) : null,
        sftpAuth: kind === 'sftp' ? input.sftpAuth : null,
        hostKey: kind === 'sftp' ? hostKey : null,
        // Le verdict du dernier contrôle ne survit pas à une modification :
        // il portait sur une configuration qui n'existe plus.
        lastError: null
    };
}

/** Ce qu'une destination sans secret ne peut pas faire ; `null` pour un genre qui n'en a pas. */
function missingSecretMessage(kind: BackupDestinationKind, auth: BackupSftpAuth | null): string | null {
    if (kind === 's3') return 'Une destination S3 exige sa clé secrète.';
    if (kind === 'webdav') return 'Une destination WebDAV exige son mot de passe.';
    if (kind === 'sftp')
        return auth === 'key' ? 'Collez la clé privée SSH.' : 'Une destination SFTP exige son mot de passe.';
    return null;
}

/**
 * Sans ce contrôle, on écrirait des archives sur la machine d'un autre espace
 * en devinant un identifiant. Écrire sur une machine relève de la surface
 * Fichiers : le droit d'Appareils se vérifie aussi, surcharges comprises.
 */
async function assertDeviceInWorkspace(ctx: Ctx, deviceId: string | null): Promise<SdkDevice> {
    const devices = await ctx.deveye.devices.list();
    if (!deviceId || !devices.some((d) => d.id === deviceId)) {
        throw new FeatureError('not_found', "Cet appareil n'appartient pas à cet espace.");
    }
    return ctx.deveye.devices.authorize(deviceId, { extras: ['files'] });
}

const destinationAddFeature = defineSdkFeature({
    ...backupDestinationAdd,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        assertDestinationShape(input.kind, input);
        const missing = missingSecretMessage(input.kind, input.sftpAuth);
        if (missing && !input.secret) throw new FeatureError('validation', missing);
        if (input.kind === 'device') await assertDeviceInWorkspace(ctx, input.deviceId);

        const stored = storedFrom(input.kind, input, null);
        const cipher = ctx.cipher();
        const row = await ctx.repo.createDestination({
            workspaceId: ctx.workspaceId,
            kind: input.kind,
            deviceId: input.kind === 'device' ? input.deviceId : null,
            pathStyle: input.pathStyle,
            content: await cipher.encrypt(JSON.stringify(stored)),
            secretEnc: missing && input.secret ? await cipher.encrypt(input.secret) : ''
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
        const kind = row.kind as BackupDestinationKind;
        assertDestinationShape(kind, input);
        if (kind === 'device') await assertDeviceInWorkspace(ctx, input.deviceId);

        const previous = await readJson<StoredDestination>(ctx, row.content);
        // Un autre mode de connexion rend l'ancien secret inutilisable : un mot
        // de passe ne sert pas de clé.
        if (kind === 'sftp' && previous.sftpAuth !== input.sftpAuth && !input.secret) {
            throw new FeatureError('validation', missingSecretMessage(kind, input.sftpAuth) ?? '');
        }
        // Un autre hôte est un autre serveur : son empreinte reste à valider.
        const sameServer = previous.host === input.host?.trim() && (previous.port ?? 22) === (input.port ?? 22);
        const hostKey = input.resetHostKey || !sameServer ? null : (previous.hostKey ?? null);

        const stored = storedFrom(kind, input, hostKey);
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
    handler: async (ctx: Ctx, input) => {
        const row = await loadDestination(ctx, input.destinationId);
        // Le contrôle écrit un fichier témoin sur la machine : même droit qu'une archive.
        if (row.kind === 'device') await assertDeviceInWorkspace(ctx, row.device_id);
        return requireEngine().probeDestination(row);
    }
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

/** Ce qu'une création ou une modification de travail désigne comme source. */
interface SourceInput {
    source: BackupSourceKind;
    sourceId: number | null;
    folder: BackupFolder | null;
}

/** La machine sait-elle archiver un dossier ? Déclaré par son agent, la version ne le dit pas. */
const archivesFolders = (device: SdkDevice): boolean =>
    device.report?.agent?.probes.includes(AGENT_FOLDER_ARCHIVE_PROBE) ?? false;

/**
 * Vérifie que la source désignée existe **dans cet espace**, et que l'appelant
 * a le droit de la sauvegarder. `jobId` : le travail modifié, dont la
 * surcharge de permissions compte.
 */
async function assertSource(ctx: Ctx, input: SourceInput, jobId?: number): Promise<void> {
    switch (input.source) {
        case 'deveye':
            if (!canBackupDevEye(ctx)) {
                throw new FeatureError(
                    'forbidden',
                    'La base de DevEye ne se sauvegarde que depuis l’espace personnel d’un administrateur.'
                );
            }
            return;

        case 'deviceFolder': {
            const folder = input.folder;
            if (!folder) throw new FeatureError('validation', 'Choisissez le dossier de la machine à sauvegarder.');
            const allowed =
                jobId === undefined
                    ? ctx.canExtra('deviceFolders')
                    : await ctx.items.canExtra(String(jobId), 'deviceFolders');
            if (!allowed) {
                throw new FeatureError(
                    'forbidden',
                    'Votre rôle ne permet pas de sauvegarder les fichiers d’une machine.'
                );
            }
            const path = folder.path.trim();
            if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
                throw new FeatureError('validation', 'Le dossier de la machine doit être un chemin absolu.');
            }
            for (const rule of folder.exclusions) {
                const problem = pathExclusionProblem(rule.kind, rule.pattern);
                if (problem) throw new FeatureError('validation', `Exclusion « ${rule.pattern} » : ${problem}`);
            }
            // Le droit Fichiers de l'appelant sur CETTE machine, surcharges comprises.
            const device = await assertDeviceInWorkspace(ctx, folder.deviceId);
            if (!archivesFolders(device)) {
                throw new FeatureError(
                    'conflict',
                    'L’agent de cette machine est à mettre à jour pour sauvegarder un dossier.'
                );
            }
            return;
        }

        case 'database': {
            if (input.sourceId === null) {
                throw new FeatureError('validation', 'Choisissez ce que ce travail doit sauvegarder.');
            }
            const databases = databaseProvider(ctx);
            if (!databases) throw new FeatureError('not_found', 'Les bases de données sont indisponibles.');
            if (!(await databases.findDatabase(input.sourceId, ctx.workspaceId))) {
                throw new FeatureError('not_found', 'Cette base de données est introuvable dans cet espace.');
            }
            return;
        }

        case 'cloudsync': {
            if (input.sourceId === null) {
                throw new FeatureError('validation', 'Choisissez ce que ce travail doit sauvegarder.');
            }
            const cloudSync = cloudSyncProvider(ctx);
            if (!cloudSync) throw new FeatureError('not_found', 'CloudSync est indisponible : module non installé.');
            const share = await cloudSync.findShare(input.sourceId);
            if (!share || share.workspaceId !== ctx.workspaceId) {
                throw new FeatureError('not_found', 'Ce partage CloudSync est introuvable dans cet espace.');
            }
            return;
        }

        default: {
            const unknown: never = input.source;
            throw new FeatureError('validation', `Source de sauvegarde inconnue : ${String(unknown)}`);
        }
    }
}

/**
 * Ce que le travail garde chiffré. Pour un dossier de machine, l'appelant en
 * devient l'auteur : c'est de ses droits que le travail tiendra les siens.
 */
function storedJobOf(ctx: Ctx, input: SourceInput & { name: string }): StoredJob {
    if (input.source !== 'deviceFolder' || !input.folder) return { name: input.name };
    return {
        name: input.name,
        folder: {
            deviceId: input.folder.deviceId,
            path: input.folder.path.trim(),
            exclusions: input.folder.exclusions,
            oneFileSystem: input.folder.oneFileSystem,
            authorUserId: ctx.userId
        }
    };
}

/** Seules les bases et les partages ont un identifiant numérique. */
const sourceIdOf = (input: SourceInput): number | null =>
    input.source === 'database' || input.source === 'cloudsync' ? input.sourceId : null;

const jobAddFeature = defineSdkFeature({
    ...backupJobAdd,
    access: { level: 'write' },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        await loadDestination(ctx, input.destinationId);
        await assertSource(ctx, input);

        const row = await ctx.repo.createJob({
            workspaceId: ctx.workspaceId,
            destinationId: input.destinationId,
            sourceKind: input.source,
            sourceId: sourceIdOf(input),
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
            content: await ctx.cipher().encrypt(JSON.stringify(storedJobOf(ctx, input)))
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
        await assertSource(ctx, input, input.jobId);

        const row = await ctx.repo.updateJob(input.jobId, ctx.workspaceId, {
            destinationId: input.destinationId,
            sourceKind: input.source,
            sourceId: sourceIdOf(input),
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
            content: await ctx.cipher().encrypt(JSON.stringify(storedJobOf(ctx, input)))
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

/**
 * Les machines de l'espace, chacune choisissable si l'appelant peut en
 * sauvegarder un dossier. Une machine qu'il ne peut pas choisir reste
 * visible, grisée, avec sa raison : c'est ainsi qu'on apprend que le droit
 * existe.
 */
async function machineCandidates(ctx: Ctx): Promise<BackupSourceCandidate[]> {
    const devices = await ctx.deveye.devices.list();
    const mayFolders = ctx.canExtra('deviceFolders');
    return Promise.all(
        devices.map(async (device): Promise<BackupSourceCandidate> => {
            const hasFiles =
                mayFolders &&
                (await ctx.deveye.devices.authorize(device.id, { extras: ['files'] }).then(
                    () => true,
                    () => false
                ));
            const refusal: { tag: string; reason: string } | null = !mayFolders
                ? { tag: 'non autorisé', reason: 'Votre rôle ne permet pas de sauvegarder les fichiers d’une machine.' }
                : !hasFiles
                  ? { tag: 'sans droit Fichiers', reason: 'Vous n’avez pas le droit Fichiers sur cette machine.' }
                  : !archivesFolders(device)
                    ? {
                          tag: 'agent à mettre à jour',
                          reason: 'L’agent de cette machine est à mettre à jour pour sauvegarder un dossier.'
                      }
                    : null;
            return {
                kind: 'deviceFolder',
                id: null,
                deviceId: device.id,
                name: device.name,
                detail: 'Un dossier de cette machine, archivé par son agent. Une machine hors ligne fait échouer ce passage-là, pas les suivants.',
                // Hors ligne n'empêche pas de choisir : le travail partira plus tard.
                tag: refusal?.tag ?? (device.online ? null : 'hors ligne'),
                available: refusal === null,
                reason: refusal?.reason ?? null
            };
        })
    );
}

const sourcesFeature = defineSdkFeature({
    ...backupSources,
    access: { level: 'read' },
    handler: async (ctx: Ctx) => {
        const candidates: BackupSourceCandidate[] = [];
        if (canBackupDevEye(ctx)) {
            candidates.push({
                kind: 'deveye',
                id: null,
                deviceId: null,
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
                deviceId: null,
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
                deviceId: null,
                name: share.name,
                detail: `${files} : les fichiers, pas leur index (celui-ci est dans la base de DevEye).`,
                tag: stats.fileCount > 0 ? files : 'vide',
                available: stats.fileCount > 0,
                reason: stats.fileCount > 0 ? null : 'Ce partage est vide.'
            });
        }

        candidates.push(...(await machineCandidates(ctx)));
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
