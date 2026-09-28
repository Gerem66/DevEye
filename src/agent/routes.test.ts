import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DeviceRow } from '@deveye/types';

import type { Database } from '@/db';
import { ORIGINS } from '@/features/_sdk/context';
import { agentRoutes } from './routes';

/**
 * Les routes de l'appairage sur un vrai Fastify et une base simulée : ce que
 * le smoke ne voit pas sans base joignable. Chaque cas enrôle depuis sa propre
 * adresse, le verrouillage des échecs étant tenu par adresse et par processus.
 */

interface Code {
    userId: number;
    workspaceId: number;
    maxUses: number;
    uses: number;
}

const OWNER = 7;
const WORKSPACE = 3;
const KNOWN = '00000000-0000-4000-8000-000000000001';
/** Le `n`-ième appareil créé par le test. */
const created = (n: number) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;

let codes: Map<string, Code>;
let devices: DeviceRow[];
let calls: string[];
let duplicateOnCreate: boolean;

function device(over: Partial<DeviceRow>): DeviceRow {
    return {
        id: KNOWN,
        owner_id: OWNER,
        workspace_id: WORKSPACE,
        name: 'known',
        fingerprint: 'fp-known',
        platform: 'linux',
        status: 'active',
        token_hash: 'old',
        token_hash_prev: null,
        last_seen: null,
        created: 1,
        agent_version: null,
        agent_target: null,
        report_json: null,
        metric_interval_seconds: null,
        process_capture: null,
        retention_days: null,
        terminal_default_user: null,
        terminal_close_on_exit: 1,
        status_before_delete: null,
        delete_error: null,
        sort_order: 0,
        ...over
    };
}

const db = {
    workspaces: {
        findById: async (id: number) => (id === WORKSPACE ? { id, owner_user_id: OWNER } : null)
    },
    workspaceMembers: { isMember: async () => false },
    workspaceRoles: { findForMember: async () => null },
    linkCodes: {
        async peek(code: string) {
            const c = codes.get(code);
            return c && c.uses < c.maxUses
                ? { userId: c.userId, workspaceId: c.workspaceId, maxUses: c.maxUses }
                : null;
        },
        async consume(code: string) {
            const c = codes.get(code);
            if (!c || c.uses >= c.maxUses) return false;
            c.uses += 1;
            calls.push(`consume:${code}`);
            return true;
        }
    },
    devices: {
        findByWorkspaceFingerprint: async (workspaceId: number, fingerprint: string) =>
            devices.find((d) => d.workspace_id === workspaceId && d.fingerprint === fingerprint) ?? null,
        async create(input: { name: string; fingerprint: string; workspaceId: number; status: DeviceRow['status'] }) {
            if (duplicateOnCreate) throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
            const row = device({
                id: created(devices.length),
                name: input.name,
                fingerprint: input.fingerprint,
                status: input.status
            });
            devices.push(row);
            return row;
        },
        async setTokenHashes(id: string) {
            calls.push(`token:${id}`);
        },
        async markEnrolled(id: string, status: string) {
            calls.push(`mark:${id}:${status}`);
        },
        findById: async (id: string) => devices.find((d) => d.id === id) ?? null
    },
    transaction: <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database)
};

let app: FastifyInstance;

before(async () => {
    app = Fastify();
    await agentRoutes(app, {
        db: db as unknown as Database,
        hub: {
            disconnectAgent: (id: string) => calls.push(`disconnect:${id}`),
            isOnline: () => false
        } as never,
        live: { changed: () => undefined } as never,
        audit: { record: () => undefined } as never
    });
    await app.ready();
});

after(() => app.close());

beforeEach(() => {
    codes = new Map([
        ['ONCE-CODE', { userId: OWNER, workspaceId: WORKSPACE, maxUses: 1, uses: 0 }],
        ['FLEET-CODE-XXXX', { userId: OWNER, workspaceId: WORKSPACE, maxUses: 3, uses: 0 }],
        ['LEFT-CODE', { userId: 42, workspaceId: WORKSPACE, maxUses: 3, uses: 0 }]
    ]);
    devices = [device({})];
    calls = [];
    duplicateOnCreate = false;
});

let ip = 0;
const enroll = (code: string, fingerprint: string, remoteAddress = `10.0.0.${++ip}`) =>
    app.inject({
        method: 'POST',
        url: '/api/agent/enroll',
        remoteAddress,
        payload: { code, name: 'box', fingerprint, platform: 'linux' }
    });

describe("l'enrôlement", () => {
    it("une machine neuve dépense un usage et s'enrôle active", async () => {
        const res = await enroll('fleet-code-xxxx', 'fp-new');
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().data.device.status, 'active');
        assert.equal(codes.get('FLEET-CODE-XXXX')?.uses, 1);
        assert.deepEqual(calls, ['consume:FLEET-CODE-XXXX', `token:${created(1)}`]);
    });

    it('un code sert autant de machines que prévu, pas une de plus', async () => {
        for (const fp of ['fp-a', 'fp-b', 'fp-c']) assert.equal((await enroll('FLEET-CODE-XXXX', fp)).statusCode, 200);
        assert.equal((await enroll('FLEET-CODE-XXXX', 'fp-d')).statusCode, 401);
    });

    it('un code à plusieurs usages refuse une machine connue, sans rien dépenser', async () => {
        const res = await enroll('FLEET-CODE-XXXX', 'fp-known');
        assert.equal(res.statusCode, 409);
        assert.equal(res.json().error.code, 'conflict');
        assert.match(res.json().error.message, /--shuffle-id/);
        assert.equal(codes.get('FLEET-CODE-XXXX')?.uses, 0);
        assert.deepEqual(calls, []);
    });

    it("un code à usage unique réappaire une machine connue, qui attend qu'on l'approuve", async () => {
        const res = await enroll('ONCE-CODE', 'fp-known');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(calls, [
            'consume:ONCE-CODE',
            `token:${KNOWN}`,
            `mark:${KNOWN}:pending`,
            `disconnect:${KNOWN}`
        ]);
    });

    it("le code d'un émetteur qui ne gère plus les appareils de l'espace ne vaut rien", async () => {
        assert.equal((await enroll('LEFT-CODE', 'fp-new')).statusCode, 401);
        assert.equal(codes.get('LEFT-CODE')?.uses, 0);
    });

    it('deux machines à la même empreinte, au même instant : la seconde est refusée', async () => {
        duplicateOnCreate = true;
        const res = await enroll('FLEET-CODE-XXXX', 'fp-twin');
        assert.equal(res.statusCode, 409);
    });

    it("les échecs verrouillent l'adresse, et un bon code ne remet pas l'ardoise à zéro", async () => {
        const from = '10.9.9.9';
        for (let i = 0; i < 5; i++) assert.equal((await enroll('GUESS-0000', 'fp-x', from)).statusCode, 401);
        const locked = await enroll('ONCE-CODE', 'fp-new', from);
        assert.equal(locked.statusCode, 429);
        assert.ok(Number(locked.headers['retry-after']) > 0);
        assert.equal(codes.get('ONCE-CODE')?.uses, 0);
        // Ailleurs, le même code passe.
        assert.equal((await enroll('ONCE-CODE', 'fp-new')).statusCode, 200);
    });
});

describe("l'installation", () => {
    it('le binaire se télécharge sur un code valable, sans en dépenser, et jamais sans', async () => {
        const target = '/api/agent/install/linux-x86_64';
        const without = await app.inject({ method: 'GET', url: target, remoteAddress: '10.1.0.1' });
        assert.equal(without.statusCode, 401);
        const withCode = await app.inject({
            method: 'GET',
            url: target,
            remoteAddress: '10.1.0.2',
            headers: { 'x-deveye-link-code': 'once-code' }
        });
        // 200 quand un binaire est construit dans `agent/dist`, 404 sinon : jamais un refus.
        assert.ok([200, 404].includes(withCode.statusCode), String(withCode.statusCode));
        assert.equal(codes.get('ONCE-CODE')?.uses, 0);
        assert.equal(
            (await app.inject({ method: 'GET', url: '/api/agent/install/amiga', remoteAddress: '10.1.0.3' }))
                .statusCode,
            400
        );
    });

    it("les scripts nomment l'origine de l'app, en texte", async () => {
        for (const path of ['/install.sh', '/install.ps1']) {
            const res = await app.inject({ method: 'GET', url: path });
            assert.equal(res.statusCode, 200);
            assert.match(String(res.headers['content-type']), /^text\/plain; charset=utf-8/);
            assert.ok(res.body.includes(`'${ORIGINS.app}'`), path);
            assert.ok(!res.body.includes('__DEVEYE_SERVER__'), path);
        }
    });
});
