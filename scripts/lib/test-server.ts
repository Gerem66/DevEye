import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const READY_MS = 90_000;

export interface TestServer {
    baseUrl: string;
    logFile: string;
    /** Où en est le journal : le repère d'où relire ce qu'un tour y écrit ensuite. */
    logSize(): number;
    /**
     * Les trente dernières lignes du journal depuis l'octet `fromByte` : le seul
     * endroit où figure la raison d'un refus, qu'un magasin client avale en
     * silence.
     */
    tailLog(fromByte?: number): void;
    stop(): void;
}

/**
 * Un serveur à soi pour le smoke et les parcours : son port, son journal
 * (`.smoke/server.log`), le compte de développement semé. La base reste celle
 * des variables DB_*. Sans `clientDir`, il ne sert que l'API. Lève s'il
 * s'arrête ou ne répond pas.
 */
export async function startTestServer({
    root,
    port,
    clientDir
}: {
    root: string;
    port: number;
    clientDir?: string;
}): Promise<TestServer> {
    const baseUrl = `http://localhost:${port}`;
    const logFile = path.join(root, '.smoke', 'server.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.openSync(logFile, 'w');
    const child = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['index.ts'], {
        cwd: root,
        env: {
            ...process.env,
            SEED_DEV: 'true',
            LISTEN_PORT: String(port),
            PUBLIC_ORIGIN: baseUrl,
            ...(clientDir ? { CLIENT_DIR: clientDir } : {}),
            // Les connexions s'enchaînent : le plafond ordinaire (200/min) les
            // ferait se bloquer entre elles.
            RATE_LIMIT_MAX: '100000',
            // Un expéditeur déclaré, sur un port où rien n'écoute : les parcours
            // à mail tournent (la boîte des essais retient leurs mails avant
            // l'envoi), et aucun autre mail ne quitte le poste.
            SMTP_HOST: '127.0.0.1',
            SMTP_PORT: '9',
            SMTP_USER: '',
            SMTP_PASSWORD: '',
            SMTP_FROM: 'DevEye <essais@deveye.invalid>',
            // Celui d'un `.env` de développement est tenu par le serveur qui
            // tourne à côté.
            PUBLIC_LISTEN_PORT: '',
            // Les parcours d'Uptime surveillent ce serveur même, à son adresse
            // locale.
            OUTBOUND_ALLOW_PRIVATE: 'true',
            // Les modules écrivent sur le disque : un essai interrompu ne laisse
            // rien dans un bucket.
            STORAGE_S3_ENDPOINT: ''
        },
        stdio: ['ignore', log, log]
    });
    fs.closeSync(log);

    const stop = (): void => {
        if (child.exitCode === null) child.kill('SIGTERM');
        setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        }, 3000).unref();
    };
    process.on('exit', stop);

    const tailLog = (fromByte = 0): void => {
        let lines: string[] = [];
        try {
            lines = fs
                .readFileSync(logFile)
                .subarray(fromByte)
                .toString('utf8')
                .split('\n')
                .filter((l) => l.trim() !== '');
        } catch {
            return;
        }
        if (lines.length === 0) return;
        console.error('  journal du serveur:');
        for (const line of lines.slice(-30)) console.error(`    ${line}`);
    };

    const deadline = Date.now() + READY_MS;
    for (;;) {
        if (child.exitCode !== null) {
            tailLog();
            throw new Error(
                `le serveur s'est arrêté avant d'être prêt (code ${child.exitCode}) : base joignable ? variables DB_* ?`
            );
        }
        try {
            if ((await fetch(`${baseUrl}/api/health`)).ok) break;
        } catch {
            // pas encore à l'écoute
        }
        if (Date.now() > deadline) {
            stop();
            tailLog();
            throw new Error(`le serveur ne répond pas après ${READY_MS / 1000} s`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }

    return { baseUrl, logFile, logSize: () => fs.statSync(logFile).size, tailLog, stop };
}
