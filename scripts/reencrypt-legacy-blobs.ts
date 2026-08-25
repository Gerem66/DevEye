/**
 * Re-chiffre une fois pour toutes les blobs restés à l'ancien format.
 *
 * DevEye n'a plus qu'un format de blob, AES-256-GCM (`Services/Encryption.ts`).
 * L'ancien (AES-256-CTR + HMAC, 2024 → juin 2026) ne vit plus que dans
 * `scripts/lib/legacy-blob.ts`, pour ce script et lui seul.
 *
 * Ce qu'il balaie, borné par l'historique git de tous les appels à l'ancien
 * `Encrypt` (aucune autre colonne n'a jamais pu le recevoir) :
 *
 *   user_2fa.secret_enc             clé serveur     écrit ainsi jusqu'au 25 août 2026
 *   passwords.content               étage gardé     jusqu'au 17 juin 2026 (0bcaeec)
 *   weather_locations.api_key_enc   étage ouvert    jusqu'au 21 août 2026 (d61b27e)
 *   weather_provider_keys.key_enc   étage ouvert    idem
 *   osint_provider_keys.key_enc     étage ouvert    jusqu'au 23 août 2026 (c8bd425)
 *
 * Pour chaque ligne : lisible sous la clé courante → rien ; sinon lisible à
 * l'ancien format → réécrite sous la clé courante ; sinon illisible → signalée
 * et jamais touchée.
 *
 * Usage :
 *   npm run reencrypt:legacy -- [--yes] [--password <userId>:<motDePasse>]...
 *
 * Dry-run par défaut (comptes réels, rien d'écrit). L'étage gardé d'un compte
 * dont la DEK est emballée par son mot de passe ne s'ouvre qu'avec ce mot de
 * passe : sans `--password` pour ce compte, ses lignes sont comptées « en
 * attente » et laissées telles quelles. Un mot de passe sur la ligne de
 * commande entre dans l'historique du shell : précéder la commande d'une
 * espace (zsh, `HIST_IGNORE_SPACE`) ou l'effacer ensuite.
 *
 * Serveur arrêté de préférence. Chaque ligne est réécrite d'un coup, sous la
 * clé que le serveur lit déjà, et relue avant l'écriture.
 */
import type { WorkspaceRow } from '@deveye/types';

import { createDatabase, type Database } from '@/db';
import { createDbPool, getQueryable, testConnection, type Queryable } from '@/db/pool';
import Encryption from '@/Services/Encryption';
import { SecretKeyService, WrongSecretError } from '@/Services/SecretKeyService';
import { env } from '@/Utils/Env';
import { classifyBlob } from './lib/legacy-blob';

type Tier = 'server' | 'open' | 'guarded';

interface Target {
    table: string;
    column: string;
    /** Les colonnes qui identifient une ligne à elles seules, pour l'UPDATE. */
    ids: string[];
    tier: Tier;
}

const TARGETS: Target[] = [
    { table: 'user_2fa', column: 'secret_enc', ids: ['user_id'], tier: 'server' },
    { table: 'passwords', column: 'content', ids: ['id'], tier: 'guarded' },
    { table: 'weather_locations', column: 'api_key_enc', ids: ['id'], tier: 'open' },
    { table: 'weather_provider_keys', column: 'key_enc', ids: ['workspace_id', 'provider'], tier: 'open' },
    { table: 'osint_provider_keys', column: 'key_enc', ids: ['workspace_id', 'provider'], tier: 'open' }
];

const YES = process.argv.includes('--yes');

function usage(): never {
    console.error('Usage: npm run reencrypt:legacy -- [--yes] [--password <userId>:<motDePasse>]...');
    process.exit(2);
}

function fail(message: string): never {
    console.error(`reencrypt-legacy: ${message}`);
    process.exit(1);
}

/** `--password 12:secret` → le mot de passe du compte 12, pour déballer sa DEK gardée. */
function parsePasswords(argv: string[]): Map<number, string> {
    const out = new Map<number, string>();
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== '--password') continue;
        const spec = argv[++i] ?? '';
        const sep = spec.indexOf(':');
        const userId = Number(spec.slice(0, sep));
        if (sep < 1 || !Number.isInteger(userId) || userId <= 0 || spec.length === sep + 1) usage();
        out.set(userId, spec.slice(sep + 1));
    }
    return out;
}

/** Un compte n'a pas encore la clé qui devrait lire cette ligne (créée à l'écriture). */
const NO_KEY_YET = Symbol('no-key-yet');
/** L'étage gardé d'un compte dont le mot de passe manque. */
const PENDING = Symbol('pending');
/** Un espace partagé sans clé propre : un invariant rompu, ses lignes ne se lisent sous rien. */
const NO_WDK = Symbol('no-wdk');

type Resolved = Buffer | typeof NO_KEY_YET | typeof PENDING | typeof NO_WDK;

/**
 * Les clés sous lesquelles chaque ligne doit se lire, résolues une fois par
 * espace. En dry-run tout est lu, rien n'est créé : un compte sans DEK reste
 * `NO_KEY_YET` (ses blobs ne peuvent être qu'anciens) ; avec `--yes` la DEK
 * manquante est posée, comme l'app l'aurait fait à la première écriture.
 */
class KeyRing {
    private readonly workspaces = new Map<number, Promise<WorkspaceRow>>();
    private readonly open = new Map<number, Promise<Resolved>>();
    private readonly guarded = new Map<number, Promise<Resolved>>();
    /** Les comptes dont l'étage gardé attend un mot de passe. */
    readonly pendingUsers = new Set<number>();
    /** Les espaces partagés sans clé propre. */
    readonly keylessWorkspaces = new Set<number>();

    constructor(
        private readonly db: Database,
        private readonly keys: SecretKeyService,
        private readonly crypt: Encryption,
        private readonly passwords: Map<number, string>,
        private readonly create: boolean
    ) {}

    keyFor(tier: Tier, workspaceId: number | null): Promise<Resolved> {
        if (tier === 'server') return Promise.resolve(this.crypt.serverKey());
        if (workspaceId === null) throw new Error('ligne sans workspace_id');
        return tier === 'open' ? this.openKey(workspaceId) : this.guardedKey(workspaceId);
    }

    private workspace(id: number): Promise<WorkspaceRow> {
        let row = this.workspaces.get(id);
        if (!row) {
            row = this.db.workspaces.findById(id).then((w) => {
                if (!w) throw new Error(`espace ${id} introuvable`);
                return w;
            });
            this.workspaces.set(id, row);
        }
        return row;
    }

    /** La WDK d'un espace partagé, ou `NO_WDK` s'il n'en a pas (à signaler, jamais à créer ici). */
    private async workspaceKey(w: WorkspaceRow): Promise<Resolved> {
        if (!(await this.db.workspaceSecretKeys.get(w.id))) {
            this.keylessWorkspaces.add(w.id);
            return NO_WDK;
        }
        return this.keys.resolveWorkspaceDek(w.id);
    }

    private openKey(workspaceId: number): Promise<Resolved> {
        let key = this.open.get(workspaceId);
        if (!key) {
            key = this.workspace(workspaceId).then(async (w) => {
                if (w.kind === 'shared') return this.workspaceKey(w);
                if (this.create) return this.keys.resolveOpenDek(w.owner_user_id);
                const row = await this.db.userSecretKeys.get(w.owner_user_id);
                if (!row?.open_dek_wrapped) return NO_KEY_YET;
                const dek = this.crypt.openRaw(row.open_dek_wrapped);
                if (!dek) throw new Error(`DEK ouverte du compte ${w.owner_user_id} illisible (clé serveur changée ?)`);
                return dek;
            });
            this.open.set(workspaceId, key);
        }
        return key;
    }

    private guardedKey(workspaceId: number): Promise<Resolved> {
        let key = this.guarded.get(workspaceId);
        if (!key) {
            key = this.workspace(workspaceId).then(async (w) => {
                // La WDK sert les deux étages d'un espace partagé.
                if (w.kind === 'shared') return this.workspaceKey(w);
                const row = this.create
                    ? await this.keys.ensureRow(w.owner_user_id)
                    : await this.db.userSecretKeys.get(w.owner_user_id);
                if (!row) return NO_KEY_YET;
                if (!this.keys.isPasswordWrapped(row)) return this.keys.unwrapWithServer(row);
                const password = this.passwords.get(w.owner_user_id);
                if (password === undefined) {
                    this.pendingUsers.add(w.owner_user_id);
                    return PENDING;
                }
                try {
                    return await this.keys.unwrapWithPassword(row, password);
                } catch (e) {
                    if (e instanceof WrongSecretError) fail(`mot de passe incorrect pour le compte ${w.owner_user_id}`);
                    throw e;
                }
            });
            this.guarded.set(workspaceId, key);
        }
        return key;
    }
}

interface Tally {
    current: number;
    legacy: number;
    unreadable: string[];
    pending: number;
    keyless: number;
}

type Row = Record<string, string | number | null> & { enc: string };

function whereOf(target: Target): string {
    return target.ids.map((c) => `${c} = ?`).join(' AND ');
}

function labelOf(target: Target, row: Row): string {
    return target.ids.map((c) => String(row[c])).join('/');
}

async function processTarget(q: Queryable, ring: KeyRing, keyA: string, keyB: string, target: Target): Promise<Tally> {
    const tally: Tally = { current: 0, legacy: 0, unreadable: [], pending: 0, keyless: 0 };
    const columns = [...target.ids, ...(target.tier === 'server' ? [] : ['workspace_id'])];
    const r = await q.query<Row>(
        `SELECT ${columns.join(', ')}, ${target.column} AS enc FROM ${target.table}
         WHERE ${target.column} IS NOT NULL AND ${target.column} <> ''`,
        []
    );
    for (const row of r.rows) {
        const workspaceId = target.tier === 'server' ? null : Number(row.workspace_id);
        const resolved = await ring.keyFor(target.tier, workspaceId);
        if (resolved === PENDING) {
            tally.pending++;
            continue;
        }
        if (resolved === NO_WDK) {
            tally.keyless++;
            continue;
        }
        const key = resolved === NO_KEY_YET ? null : resolved;
        const state = classifyBlob(key, keyA, keyB, row.enc);
        if (state.state === 'current') {
            tally.current++;
        } else if (state.state === 'unreadable') {
            tally.unreadable.push(labelOf(target, row));
        } else {
            tally.legacy++;
            if (!YES) continue;
            // Avec --yes la clé a été posée au besoin : elle existe forcément.
            if (key === null) throw new Error(`${target.table} : clé absente en mode écriture`);
            const sealed = Encryption.encryptWithKey(key, state.plaintext);
            // Relu avant d'être écrit : la ligne ne peut pas finir sous une clé
            // que le serveur ne lirait pas.
            if (Encryption.decryptWithKey(key, sealed) !== state.plaintext) {
                fail(
                    `${target.table}.${target.column} ${labelOf(target, row)} : relecture impossible, rien n'est écrit`
                );
            }
            await q.query(`UPDATE ${target.table} SET ${target.column} = ? WHERE ${whereOf(target)}`, [
                sealed,
                ...target.ids.map((c) => row[c])
            ]);
        }
    }
    return tally;
}

async function main(): Promise<void> {
    const passwords = parsePasswords(process.argv.slice(2));
    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (tunnel ouvert ? variables DB_* ?)');
    const q = getQueryable(pool);
    const db = createDatabase(q);
    const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);
    const ring = new KeyRing(db, new SecretKeyService(db, crypt), crypt, passwords, YES);

    console.log(`Re-chiffrement des blobs à l'ancien format — ${YES ? 'EXÉCUTION' : 'dry-run, rien ne sera écrit'}\n`);

    let legacy = 0;
    let unreadable = 0;
    for (const target of TARGETS) {
        const t = await processTarget(q, ring, env.CRYPT_KEY_A, env.CRYPT_KEY_B, target);
        legacy += t.legacy;
        unreadable += t.unreadable.length;
        const parts = [
            `${t.current} à jour`,
            `${t.legacy} ${YES ? 'convertie(s)' : 'à convertir'}`,
            ...(t.pending > 0 ? [`${t.pending} en attente d'un mot de passe`] : []),
            ...(t.keyless > 0 ? [`${t.keyless} dans un espace partagé SANS CLÉ`] : []),
            ...(t.unreadable.length > 0 ? [`${t.unreadable.length} ILLISIBLE(S) : ${t.unreadable.join(', ')}`] : [])
        ];
        console.log(`  ${target.table}.${target.column}`.padEnd(36) + parts.join(', '));
    }
    await pool.end();

    console.log('');
    if (ring.pendingUsers.size > 0) {
        const ids = [...ring.pendingUsers].sort((a, b) => a - b);
        console.log(
            `Étage gardé emballé par mot de passe pour le(s) compte(s) ${ids.join(', ')} : relancer avec ` +
                ids.map((id) => `--password ${id}:<motDePasse>`).join(' ')
        );
    }
    if (ring.keylessWorkspaces.size > 0) {
        console.log(
            `Espace(s) partagé(s) sans clé propre : ${[...ring.keylessWorkspaces].join(', ')}. Invariant rompu ` +
                '(tout espace partagé naît avec sa WDK) : leurs lignes ne se lisent sous aucune clé, rien n’a été touché.'
        );
    }
    if (unreadable > 0) {
        console.log(
            `${unreadable} blob(s) illisible(s) sous les deux formats : à examiner à la main, rien n'a été touché.`
        );
    }
    if (YES) console.log(`${legacy} blob(s) réécrit(s) au format courant.`);
    else if (legacy > 0) console.log(`${legacy} blob(s) à convertir : relancer avec --yes.`);
    else console.log('Rien à convertir.');

    process.exit(unreadable > 0 || ring.keylessWorkspaces.size > 0 || (YES && ring.pendingUsers.size > 0) ? 1 : 0);
}

main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
});
