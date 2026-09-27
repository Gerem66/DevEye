import {
    exportTableRows,
    FeatureError,
    type FeatureAccountExport,
    type SdkCipher,
    type SdkExportTable,
    type SdkExportWriter,
    type SdkLogger,
    type SdkQueryable,
    type SdkServerKeys
} from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { SecretKeyService } from '@/Services/SecretKeyService';
import { NameBook, safeSegment } from './names';
import type { ZipWriter } from './zip';

/** Un module, tel que l'export le parcourt : ce qu'il déclare, lié à son repo. */
export interface ExportModule {
    id: string;
    label: string;
    entry: FeatureAccountExport<unknown> | undefined;
    repo: unknown;
    keys: SdkServerKeys;
}

export interface ExportHost {
    db: Database;
    crypt: Encryption;
    q: SdkQueryable;
    modules: readonly ExportModule[];
    /** L'adresse de ce DevEye, dite dans le rapport. */
    instance: string;
    logger: SdkLogger;
}

export interface ExportRequest {
    userId: number;
    /** Les parties optionnelles laissées de côté, `<featureId>.<clé>`. */
    leaveOut: ReadonlySet<string>;
    /** L'étage gardé du compte : la clé prêtée à cet export. */
    guarded: Cipher;
    signal: AbortSignal;
    /** Relu entre deux fonctionnalités : un compte supprimé ou une session révoquée arrête l'export. */
    stillValid(): Promise<boolean>;
}

type FeatureStatus = 'ok' | 'partial' | 'notCovered';

interface FeatureReport {
    id: string;
    label: string;
    status: FeatureStatus;
    skipped: { table: string; reason: string }[];
    unreadable: number;
    errors: string[];
    /** Les fichiers écrits sous ses dossiers. */
    files: number;
}

export interface ExportReport {
    format: 'deveye-account-export/1';
    generatedAt: string;
    instance: string;
    account: { id: number; username: string };
    workspaces: { id: number; name: string; kind: string; folder: string }[];
    /** Les parties que le titulaire a laissées de côté, `<featureId>.<clé>`, et leur nom. */
    leftOut: { key: string; label: string }[];
    features: FeatureReport[];
}

const iso = (seconds: number | null | undefined): string | null =>
    seconds === null || seconds === undefined || Number(seconds) === 0
        ? null
        : new Date(Number(seconds) * 1000).toISOString();

function parseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/**
 * Les lectures d'un export. Le pilote rend une colonne `DATE` en objet `Date`
 * à minuit heure locale, que l'ISO décalerait d'un jour à Paris : elle sort en
 * date de calendrier.
 */
export function exportQueryable(q: SdkQueryable): SdkQueryable {
    const pad = (n: number): string => String(n).padStart(2, '0');
    const cell = (value: unknown): unknown =>
        value instanceof Date &&
        value.getHours() === 0 &&
        value.getMinutes() === 0 &&
        value.getSeconds() === 0 &&
        value.getMilliseconds() === 0
            ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
            : value;
    return {
        query: async <T extends object>(sql: string, params?: unknown[]) =>
            (await q.query<Record<string, unknown>>(sql, params)).map(
                (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])) as T
            ),
        execute: q.execute
    };
}

/** Une image en data URL, rendue en octets et en extension ; `null` pour tout le reste (un nom de fichier par défaut). */
function dataUrlFile(value: string | null | undefined): { bytes: Buffer; ext: string } | null {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(value ?? '');
    if (!m) return null;
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    return { bytes: Buffer.from(m[2], 'base64'), ext };
}

async function* jsonArray(first: unknown, rest: AsyncIterator<unknown>): AsyncGenerator<Buffer> {
    yield Buffer.from(`[\n${JSON.stringify(first)}`);
    for (let next = await rest.next(); !next.done; next = await rest.next()) {
        yield Buffer.from(`,\n${JSON.stringify(next.value)}`);
    }
    yield Buffer.from('\n]\n');
}

/**
 * Tout ce que le compte possède, dans l'archive : son profil, chaque espace
 * qu'il possède, et dans chacun ce que chaque fonctionnalité déclare. Une
 * fonctionnalité qui échoue est notée au rapport et les autres continuent ;
 * une clé retirée ou un téléchargement interrompu arrêtent tout.
 */
export async function writeAccountExport(zip: ZipWriter, host: ExportHost, req: ExportRequest): Promise<ExportReport> {
    const { db, q } = host;
    const names = new NameBook();
    const account = await db.users.findById(req.userId);
    if (!account) throw new FeatureError('not_found', 'Compte introuvable');

    const written: string[] = [];
    const add = (path: string, source: Uint8Array | AsyncIterable<Uint8Array>, opts?: { compress?: boolean }) => {
        const taken = names.take(path);
        written.push(taken);
        return zip.add(taken, source, opts);
    };
    const json = (path: string, value: unknown) => add(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    const rows = async (path: string, source: AsyncIterable<unknown>): Promise<void> => {
        const it = source[Symbol.asyncIterator]();
        const first = await it.next();
        if (first.done) return;
        await add(path, jsonArray(first.value, it));
    };
    const aborted = (): void => {
        if (req.signal.aborted) throw new Error('Téléchargement interrompu');
    };

    const owned = (
        await q.query<{ id: number; kind: 'personal' | 'shared'; name: string; created: number }>(
            'SELECT id, kind, name, created FROM workspaces WHERE owner_user_id = ? ORDER BY kind = ?, id',
            [req.userId, 'shared']
        )
    ).map((w) => ({ ...w, id: Number(w.id) }));
    const memberships = await q.query<{ id: number; name: string; owner: string }>(
        `SELECT w.id, w.name, u.username AS owner FROM workspace_members m
           JOIN workspaces w ON w.id = m.workspace_id JOIN users u ON u.id = w.owner_user_id
          WHERE m.user_id = ? AND w.owner_user_id <> ? ORDER BY w.id`,
        [req.userId, req.userId]
    );

    // ── Le compte ─────────────────────────────────────────────────────────
    const keyRow = await new SecretKeyService(db, host.crypt).ensureRow(req.userId);
    const [twoFactor] = await q.query<{ enabled: number }>('SELECT enabled FROM user_2fa WHERE user_id = ?', [
        req.userId
    ]);
    const instances = await q.query<{ label: string; origin: string; created: number }>(
        'SELECT label, origin, created FROM remote_instances WHERE user_id = ? ORDER BY sort_order, id',
        [req.userId]
    );
    const sessions = await q.query<{ created_at: number; expires_at: number; revoked_at: number | null }>(
        'SELECT created_at, expires_at, revoked_at FROM refresh_tokens WHERE user_id = ? ORDER BY created_at',
        [req.userId]
    );
    await json('Compte/compte.json', {
        compte: {
            id: account.id,
            pseudo: account.username,
            adresse: account.email,
            role: account.role,
            etat: account.status,
            couleur: account.color,
            creeLe: iso(account.created),
            derniereConnexion: iso(account.last_login),
            conditionsAccepteesLe: iso(account.terms_accepted_at),
            reglages: parseJson(account.settings)
        },
        securite: {
            chiffrementParMotDePasse: new SecretKeyService(db, host.crypt).isPasswordWrapped(keyRow),
            doubleAuthentification: Boolean(twoFactor?.enabled)
        },
        espacesPossedes: owned.map((w) => ({ id: w.id, nom: w.name, genre: w.kind })),
        espacesOuVousEtesMembre: memberships.map((w) => ({ id: Number(w.id), nom: w.name, proprietaire: w.owner })),
        instancesDistantes: instances.map((i) => ({ nom: i.label, adresse: i.origin, ajouteeLe: iso(i.created) })),
        sessions: sessions.map((s) => ({
            ouverteLe: iso(s.created_at),
            expireLe: iso(s.expires_at),
            fermeeLe: iso(s.revoked_at)
        }))
    });
    const avatar = dataUrlFile(account.avatar);
    if (avatar) await add(`Compte/avatar.${avatar.ext}`, avatar.bytes, { compress: false });
    const noop = (): void => undefined;
    await rows(
        'Compte/journal.json',
        exportTableRows(
            q,
            'logs',
            { file: 'journal.json', where: 'uid = ?', key: ['id'], json: ['metadata'], dates: { date: 's' } },
            req.userId,
            async () => null,
            noop
        )
    );
    await rows(
        'Compte/retours.json',
        exportTableRows(
            q,
            'feedback',
            {
                file: 'retours.json',
                where: 'uid = ?',
                key: ['id'],
                json: ['snapshot'],
                dates: { created: 's', handled_at: 's' },
                omit: ['handled_by']
            },
            req.userId,
            async () => null,
            noop
        )
    );

    // ── Les fonctionnalités ───────────────────────────────────────────────
    const modules = [...host.modules].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
    const reports = new Map<string, FeatureReport>(
        modules.map((m) => [
            m.id,
            {
                id: m.id,
                label: m.label,
                status: m.entry ? 'ok' : 'notCovered',
                skipped: [],
                unreadable: 0,
                errors: [],
                files: 0
            }
        ])
    );
    for (const m of modules) {
        for (const [table, fate] of Object.entries(m.entry?.tables ?? {})) {
            if (typeof fate === 'object' && 'skip' in fate)
                reports.get(m.id)?.skipped.push({ table, reason: fate.skip });
        }
    }

    const personal = owned.find((w) => w.kind === 'personal');
    const openOf = new Map<number, Cipher>();
    const openCipher = (workspaceId: number): Cipher => {
        let cipher = openOf.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(db, host.crypt, workspaceId);
            openOf.set(workspaceId, cipher);
        }
        return cipher;
    };
    /** L'étage gardé d'un espace : la clé prêtée dans l'espace personnel, la clé de l'espace ailleurs. */
    const guardedOf = (workspaceId: number): SdkCipher =>
        workspaceId === personal?.id ? req.guarded : openCipher(workspaceId);
    const opener = (workspaceId: number) => async (blob: string) =>
        (await openCipher(workspaceId).tryDecrypt(blob)) ?? (await guardedOf(workspaceId).tryDecrypt(blob));

    /** Ce qu'une fonctionnalité écrit, sous son dossier ; une table d'une autre portée que celle du contexte est refusée. */
    const writerFor = (
        m: ExportModule,
        root: string,
        scope: { kind: 'workspace'; id: number } | { kind: 'account' },
        report: FeatureReport
    ): SdkExportWriter => ({
        json: (path, value) => json(`${root}/${path}`, value),
        rows: (path, source) => rows(`${root}/${path}`, source),
        table: async (table, spec) => {
            const fate = m.entry?.tables[table];
            if (!fate || (typeof fate === 'object' && 'skip' in fate)) {
                throw new Error(`table « ${table} » non déclarée à l'export`);
            }
            await tableRows(table, spec, scope, root, report);
        },
        file: (path, bytes, opts) => add(`${root}/${path}`, bytes, opts)
    });

    const tableRows = async (
        table: string,
        spec: SdkExportTable,
        scope: { kind: 'workspace'; id: number } | { kind: 'account' },
        root: string,
        report: FeatureReport
    ): Promise<void> => {
        const wanted = spec.scope ?? 'workspace';
        if (wanted !== scope.kind) throw new Error(`table « ${table} » de portée ${wanted} hors de son contexte`);
        const id = scope.kind === 'workspace' ? scope.id : req.userId;
        const open = scope.kind === 'workspace' ? opener(scope.id) : opener(personal?.id ?? 0);
        await rows(
            `${root}/${spec.file}`,
            exportTableRows(q, table, spec, id, open, () => {
                report.unreadable++;
            })
        );
    };

    const failed = (report: FeatureReport, e: unknown): void => {
        if (e instanceof FeatureError && e.code === 'locked') throw e;
        aborted();
        report.errors.push((e as Error).message);
        report.status = report.status === 'notCovered' ? 'notCovered' : 'partial';
        host.logger.warn(
            { feature: report.id, err: (e as Error).message },
            'Export de compte : fonctionnalité en échec'
        );
    };

    const includes = (m: ExportModule) => (key: string) => !req.leaveOut.has(`${m.id}.${key}`);

    // Ce que les fonctionnalités gardent par compte, une fois.
    for (const m of modules) {
        const report = reports.get(m.id) as FeatureReport;
        const accountTables = Object.entries(m.entry?.tables ?? {}).filter(
            (entry): entry is [string, SdkExportTable] =>
                typeof entry[1] === 'object' && !('skip' in entry[1]) && entry[1].scope === 'account'
        );
        if (accountTables.length === 0 && !m.entry?.account) continue;
        aborted();
        const root = `Compte/${safeSegment(m.label)}`;
        try {
            for (const [table, spec] of accountTables) await tableRows(table, spec, { kind: 'account' }, root, report);
            await m.entry?.account?.({
                repo: m.repo,
                q,
                userId: req.userId,
                out: writerFor(m, root, { kind: 'account' }, report),
                includes: includes(m),
                keys: m.keys,
                signal: req.signal,
                logger: host.logger,
                workspaceIds: owned.map((w) => w.id)
            });
        } catch (e) {
            failed(report, e);
        }
    }

    const folders: ExportReport['workspaces'] = [];
    for (const workspace of owned) {
        if (!(await req.stillValid())) throw new FeatureError('auth_invalid', 'Session révoquée pendant l’export');
        const base = names.take(`Espaces/${workspace.name}`);
        folders.push({ id: workspace.id, name: workspace.name, kind: workspace.kind, folder: base });
        await json(`${base}/espace.json`, await workspaceSheet(host, workspace.id, opener(workspace.id)));
        const [logo] = await q.query<{ logo: string | null }>('SELECT logo FROM workspaces WHERE id = ?', [
            workspace.id
        ]);
        const logoFile = dataUrlFile(logo?.logo);
        if (logoFile) await add(`${base}/logo.${logoFile.ext}`, logoFile.bytes, { compress: false });

        for (const m of modules) {
            aborted();
            const report = reports.get(m.id) as FeatureReport;
            const root = `${base}/${safeSegment(m.label)}`;
            try {
                await storeRows(host, m, workspace.id, openCipher(workspace.id), guardedOf(workspace.id), root, json);
                for (const [table, fate] of Object.entries(m.entry?.tables ?? {})) {
                    if (typeof fate !== 'object' || 'skip' in fate || (fate.scope ?? 'workspace') !== 'workspace')
                        continue;
                    await tableRows(table, fate, { kind: 'workspace', id: workspace.id }, root, report);
                }
                await m.entry?.workspace?.({
                    repo: m.repo,
                    q,
                    userId: req.userId,
                    out: writerFor(m, root, { kind: 'workspace', id: workspace.id }, report),
                    includes: includes(m),
                    keys: m.keys,
                    signal: req.signal,
                    logger: host.logger,
                    workspace: { id: workspace.id, kind: workspace.kind, name: workspace.name },
                    cipher: (mode) => (mode === 'private' ? guardedOf(workspace.id) : openCipher(workspace.id)),
                    open: opener(workspace.id)
                });
            } catch (e) {
                failed(report, e);
            }
        }
    }

    const features = [...reports.values()].map((r) => {
        const roots = [
            `Compte/${safeSegment(r.label)}/`,
            ...folders.map((f) => `${f.folder}/${safeSegment(r.label)}/`)
        ];
        return {
            ...r,
            status: (r.status === 'ok' && r.unreadable > 0 ? 'partial' : r.status) as FeatureStatus,
            files: written.filter((path) => roots.some((root) => path.startsWith(root))).length
        };
    });
    const report: ExportReport = {
        format: 'deveye-account-export/1',
        generatedAt: new Date().toISOString(),
        instance: host.instance,
        account: { id: account.id, username: account.username },
        workspaces: folders,
        leftOut: [...req.leaveOut].map((key) => {
            const [id, part] = key.split('.');
            return { key, label: host.modules.find((m) => m.id === id)?.entry?.files?.[part]?.label ?? key };
        }),
        features
    };
    await add('LISEZMOI.txt', Buffer.from(readme(report, memberships.length)));
    await json('export.json', report);
    return report;
}

/** Les préférences d'une fonctionnalité dans un espace (`feature_kv`), ouvertes selon leur étage, moins ses clés secrètes. */
async function storeRows(
    host: ExportHost,
    m: ExportModule,
    workspaceId: number,
    open: SdkCipher,
    guarded: SdkCipher,
    root: string,
    json: (path: string, value: unknown) => Promise<void>
): Promise<void> {
    const omitted = new Set(m.entry?.store?.omit ?? []);
    const kv = await host.q.query<{ k: string; mode: 'server' | 'private' | 'none'; value: string }>(
        'SELECT k, mode, value FROM feature_kv WHERE workspace_id = ? AND feature = ? ORDER BY k',
        [workspaceId, m.id]
    );
    const out: Record<string, unknown> = {};
    for (const row of kv) {
        if (omitted.has(row.k)) continue;
        const plain =
            row.mode === 'none' ? row.value : await (row.mode === 'private' ? guarded : open).tryDecrypt(row.value);
        out[row.k] = plain === null ? null : parseJson(plain);
    }
    if (Object.keys(out).length > 0) await json(`${root}/preferences.json`, out);
}

/** Ce qu'un espace est : ses réglages, ses rôles, ses membres, ses canaux de notification (sans leur adresse), ses domaines. */
async function workspaceSheet(
    host: ExportHost,
    workspaceId: number,
    open: (blob: string) => Promise<string | null>
): Promise<unknown> {
    const { q } = host;
    const [w] = await q.query<{
        name: string;
        kind: string;
        created: number;
        features: unknown;
        theme: string | null;
        home_layout: string | null;
    }>('SELECT name, kind, created, features, theme, home_layout FROM workspaces WHERE id = ?', [workspaceId]);
    const roles = await q.query<{
        id: number;
        name: string;
        color: string;
        capabilities: unknown;
        features: unknown;
        is_default: number;
    }>(
        'SELECT id, name, color, capabilities, features, is_default FROM workspace_roles WHERE workspace_id = ? ORDER BY position, id',
        [workspaceId]
    );
    const members = await q.query<{ username: string; role_id: number | null; date: number }>(
        `SELECT u.username, m.role_id, m.date FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? ORDER BY m.date, m.id`,
        [workspaceId]
    );
    const channels = await q.query<{ feature: string; kind: string; label_enc: string | null; enabled: number }>(
        'SELECT feature, kind, label_enc, enabled FROM notification_channels WHERE workspace_id = ? ORDER BY position, id',
        [workspaceId]
    );
    const domains = await q.query<{ feature: string; host: string; verified_at: number | null; created: number }>(
        'SELECT feature, host, verified_at, created FROM feature_domains WHERE workspace_id = ? ORDER BY id',
        [workspaceId]
    );
    return {
        nom: w?.name,
        genre: w?.kind,
        creeLe: iso(w?.created),
        fonctionnalites: parseJson(w?.features),
        theme: parseJson(w?.theme),
        accueil: parseJson(w?.home_layout),
        roles: roles.map((r) => ({
            id: Number(r.id),
            nom: r.name,
            couleur: r.color,
            capacites: parseJson(r.capabilities),
            fonctionnalites: parseJson(r.features),
            parDefaut: Boolean(r.is_default)
        })),
        membres: members.map((m) => ({
            pseudo: m.username,
            role: roles.find((r) => Number(r.id) === Number(m.role_id))?.name ?? null,
            depuis: iso(m.date)
        })),
        canauxDeNotification: await Promise.all(
            channels.map(async (c) => ({
                fonctionnalite: c.feature,
                genre: c.kind,
                nom: c.label_enc ? await open(c.label_enc) : null,
                actif: Boolean(c.enabled)
            }))
        ),
        domaines: domains.map((d) => ({
            fonctionnalite: d.feature,
            nom: d.host,
            verifie: d.verified_at !== null,
            ajouteLe: iso(d.created)
        }))
    };
}

/** Ce que l'archive contient, pour qui l'ouvre sans rien savoir de DevEye. */
function readme(report: ExportReport, foreign: number): string {
    // Les exclusions d'une fonctionnalité dont l'archive ne porte rien n'apprendraient rien : export.json les garde.
    const skipped = report.features
        .filter((f) => f.files > 0)
        .flatMap((f) => f.skipped.map((s) => `- ${f.label} : ${s.reason}`));
    const notCovered = report.features.filter((f) => f.status === 'notCovered').map((f) => f.label);
    const failed = report.features.filter((f) => f.errors.length > 0).map((f) => `- ${f.label} : ${f.errors[0]}`);
    const unreadable = report.features.reduce((n, f) => n + f.unreadable, 0);
    return [
        `Export des données du compte « ${report.account.username} », depuis ${report.instance}, le ${new Date(report.generatedAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}.`,
        '',
        'ATTENTION : cette archive contient vos données en clair, y compris ce que protège votre mot de passe (le coffre de mots de passe, les notes privées, les recherches OSINT). Gardez-la en lieu sûr, et supprimez-la quand vous n’en avez plus besoin.',
        '',
        'Contenu',
        '- Compte/ : votre profil, vos réglages, vos sessions, votre journal d’activité, vos retours, et ce que les fonctionnalités gardent par compte.',
        '- Espaces/<nom>/ : chaque espace que vous possédez. espace.json dit ses réglages, ses rôles, ses membres et ses canaux de notification ; puis un dossier par fonctionnalité.',
        '- export.json : ce même rapport, lisible par un programme.',
        '',
        'Formats : JSON en UTF-8, dates en ISO 8601 (UTC). Une longue liste est un tableau JSON, un élément par ligne. Le courrier hébergé est en .eml, les fichiers sont tels quels.',
        '',
        'Jamais exporté : votre mot de passe et ses empreintes, le secret de la double authentification et ses codes de secours, les clés de chiffrement, les jetons de session, les identifiants de connexion à des services tiers (clés d’API, mots de passe d’intégration), et les adresses secrètes (webhooks, calendriers privés).',
        '',
        'Laissé de côté',
        ...(skipped.length > 0 ? skipped : ['- Rien d’autre.']),
        ...(foreign > 0
            ? [
                  `- ${foreign} espace(s) dont vous n’êtes que membre : listés dans Compte/compte.json, leurs données appartiennent à leur propriétaire.`
              ]
            : []),
        ...report.leftOut.map(({ label }) => `- ${label} : à votre demande.`),
        ...(notCovered.length > 0
            ? ['', `Ces fonctionnalités n’exportent que leurs préférences : ${notCovered.join(', ')}.`]
            : []),
        ...(failed.length > 0 ? ['', 'Erreurs', ...failed] : []),
        ...(unreadable > 0 ? ['', `${unreadable} valeur(s) chiffrée(s) illisible(s), laissée(s) vide(s).`] : []),
        ''
    ].join('\n');
}
