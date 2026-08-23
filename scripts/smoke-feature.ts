/**
 * Smoke E2E du chemin CLIENT d'un module de feature — au navigateur piloté (CDP).
 *
 * Pourquoi ce script existe : le bug du registre des commandes (un module dont
 * chaque commande était refusée côté client, « Unknown command », interface en
 * chargement pour toujours) a traversé typechecks, tests, sentinelles de boot
 * et smoke WS. Seul un navigateur réel l'a vu. Ce script rejoue ce chemin-là,
 * et il s'exécute À CHAQUE migration de feature vers le SDK.
 *
 * Ce qu'il vérifie, dans l'ordre :
 *  1. l'app se charge et la connexion (compte seedé) aboutit — sans exception
 *     JS (le bug de la page blanche par cycle d'imports lèverait ici) ;
 *  2. la feature est dans le marché d'ajout (le bug « Météo absente du
 *     catalogue » lèverait ici) ;
 *  3. sa tuile posée, une commande du module part sur le fil ET reçoit une
 *     réponse `ok` (le bug du registre des commandes lèverait ici) ;
 *  4. la vue complète s'ouvre et déclenche un nouvel aller-retour.
 *
 * Prérequis : le serveur tourne et sert le client CONSTRUIT
 * (`npm run build` puis `npm start`, ou un dev complet), avec un compte seedé
 * (`SEED_DEV=true`, identifiants par défaut dev / devdevdev).
 *
 * Usage :
 *   npx tsx scripts/smoke-feature.ts <featureId> <label> [--url=http://localhost:3000] [--headed]
 *   npx tsx scripts/smoke-feature.ts osint OSINT
 *   npx tsx scripts/smoke-feature.ts weather Météo
 *
 * Env : SMOKE_USERNAME / SMOKE_PASSWORD (défaut : le seed dev),
 *       SMOKE_BROWSER (défaut : chromium-browser).
 *
 * Aucune dépendance : Chromium est piloté en CDP brut sur le WebSocket global
 * de Node (>= 22). Les sélecteurs s'appuient sur les textes de l'interface et
 * les noms locaux des classes CSS modules (conservés au build par Vite) — si
 * l'un d'eux casse, le message d'échec nomme l'étape.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------------ arguments

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Map(
    process.argv
        .slice(2)
        .filter((a) => a.startsWith('--'))
        .map((a) => {
            const eq = a.indexOf('=');
            return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
        })
);

const FEATURE = positional[0];
const LABEL = positional[1];
if (!FEATURE || !LABEL) {
    console.error('Usage: npx tsx scripts/smoke-feature.ts <featureId> <label> [--url=...] [--headed]');
    process.exit(2);
}
const BASE_URL = flags.get('url') ?? 'http://localhost:3000';
const HEADED = flags.has('headed');
const USERNAME = process.env.SMOKE_USERNAME ?? 'dev';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'devdevdev';
const BROWSER = process.env.SMOKE_BROWSER ?? 'chromium-browser';
/** Le préfixe des commandes du module (casse historique tolérée : cloudSync.*). */
const PREFIX = `${FEATURE.toLowerCase()}.`;

// ------------------------------------------------------------------ client CDP

interface CdpEvent {
    method: string;
    params: Record<string, never>;
    sessionId?: string;
}

class Cdp {
    private ws: WebSocket;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
    private listeners: ((e: CdpEvent) => void)[] = [];

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(String(ev.data)) as {
                id?: number;
                result?: never;
                error?: { message: string };
                method?: string;
                params?: Record<string, never>;
                sessionId?: string;
            };
            if (msg.id !== undefined) {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message));
                else p.resolve(msg.result as never);
                return;
            }
            if (msg.method) {
                for (const cb of this.listeners) {
                    cb({ method: msg.method, params: msg.params ?? ({} as never), sessionId: msg.sessionId });
                }
            }
        });
    }

    static connect(url: string): Promise<Cdp> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            ws.addEventListener('open', () => resolve(new Cdp(ws)));
            ws.addEventListener('error', () => reject(new Error(`Connexion CDP impossible: ${url}`)));
        });
    }

    send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as never, reject });
        });
    }

    on(cb: (e: CdpEvent) => void): void {
        this.listeners.push(cb);
    }

    close(): void {
        this.ws.close();
    }
}

// ------------------------------------------------------------------ helpers

function fail(step: string, detail: string): never {
    console.error(`\n✗ ÉCHEC — ${step}\n  ${detail}`);
    process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ce que la page affichait au moment d'un échec — rempli par `main` une fois
 *  la session CDP ouverte, pour que tout échec dise CE QUE l'écran montrait. */
let dumpPageText: () => Promise<string> = () => Promise.resolve('');

/** Attend qu'un prédicat (évalué en boucle) devienne vrai, sinon échoue en nommant l'étape. */
async function waitFor(step: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(200);
    }
    const shown = (await dumpPageText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
    fail(step, `délai de ${timeoutMs} ms dépassé\n  écran: ${shown}`);
}

// ------------------------------------------------------------------ scénario

async function main(): Promise<void> {
    const profile = mkdtempSync(path.join(tmpdir(), 'deveye-smoke-'));
    const args = [
        ...(HEADED ? [] : ['--headless=new']),
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI',
        'about:blank'
    ];
    const browser: ChildProcess = spawn(BROWSER, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const cleanup = (): void => {
        browser.kill('SIGKILL');
        try {
            rmSync(profile, { recursive: true, force: true });
        } catch {
            // Chromium écrit encore pendant qu'on le tue : un profil temporaire
            // qui traîne dans /tmp ne vaut pas un échec de smoke.
        }
    };
    process.on('exit', cleanup);

    // « DevTools listening on ws://... » arrive sur stderr au démarrage.
    const wsUrl = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Chromium n’a pas annoncé son port DevTools')), 15_000);
        browser.stderr?.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
            if (m) {
                clearTimeout(timer);
                resolve(m[1]);
            }
        });
        browser.on('exit', () => reject(new Error(`Chromium s'est arrêté (binaire: ${BROWSER})`)));
    }).catch((e: Error) => fail('lancement du navigateur', e.message));

    const cdp = await Cdp.connect(wsUrl);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    // --- collecte : exceptions, console.error, et trames WS de l'app ---------
    const exceptions: string[] = [];
    const consoleErrors: string[] = [];
    /** requestId -> commande, pour les trames sorties portant le préfixe du module. */
    const sentByRequest = new Map<string, string>();
    /** Allers-retours ACCOMPLIS (réponse ok) des commandes du module. */
    const roundTrips: string[] = [];
    let refusedLocally = 0;

    cdp.on((e) => {
        if (e.sessionId !== sessionId) return;
        if (e.method === 'Runtime.exceptionThrown') {
            const d = e.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
            exceptions.push(d.exceptionDetails?.exception?.description ?? d.exceptionDetails?.text ?? 'exception');
        }
        if (e.method === 'Runtime.consoleAPICalled') {
            const d = e.params as { type?: string; args?: { value?: unknown; description?: string }[] };
            if (d.type === 'error') {
                const text = (d.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
                consoleErrors.push(text);
                // Le bug historique : refus LOCAL avant la socket. Il ne produit
                // aucune trame, donc seule la console le trahit.
                if (text.includes('Unknown command')) refusedLocally++;
            }
        }
        if (e.method === 'Network.webSocketFrameSent') {
            const d = e.params as { response?: { payloadData?: string } };
            try {
                const frame = JSON.parse(d.response?.payloadData ?? '') as { requestId?: string; command?: string };
                if (frame.command && frame.command.toLowerCase().startsWith(PREFIX) && frame.requestId) {
                    sentByRequest.set(frame.requestId, frame.command);
                }
            } catch {
                /* trame non-JSON (ping) : rien à faire */
            }
        }
        if (e.method === 'Network.webSocketFrameReceived') {
            const d = e.params as { response?: { payloadData?: string } };
            try {
                const frame = JSON.parse(d.response?.payloadData ?? '') as {
                    requestId?: string;
                    payload?: { ok?: boolean };
                };
                const command = frame.requestId ? sentByRequest.get(frame.requestId) : undefined;
                if (command && frame.payload?.ok === true) roundTrips.push(command);
            } catch {
                /* idem */
            }
        }
    });

    /** Évalue une expression dans la page et rend sa valeur (JSON-compatible). */
    const evaluate = async <T>(expression: string): Promise<T> => {
        const res = await cdp.send<{ result: { value: T } }>(
            'Runtime.evaluate',
            { expression, returnByValue: true },
            sessionId
        );
        return res.result.value;
    };

    /** Un élément (bouton de préférence) portant exactement ce texte, cliqué. */
    const clickByText = (text: string): Promise<boolean> =>
        evaluate<boolean>(`(() => {
            const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
            const all = [...document.querySelectorAll('button, [role="button"], a, span, h3, div')];
            const hit = all.filter((el) => norm(el.textContent) === ${JSON.stringify(text)})
                .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0];
            if (!hit) return false;
            (hit.closest('button, [role="button"], a') ?? hit).click();
            return true;
        })()`);

    /** Renseigne un input contrôlé par React (setter natif + événement input). */
    const setInput = (selector: string, value: string): Promise<boolean> =>
        evaluate<boolean>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);

    const exists = (selector: string): Promise<boolean> =>
        evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`);

    dumpPageText = () => evaluate<string>(`document.body ? document.body.innerText : '(pas de body)'`);

    // --- 1. chargement et connexion ------------------------------------------
    console.log(`Smoke « ${FEATURE} » (${LABEL}) sur ${BASE_URL}`);
    await cdp.send('Page.navigate', { url: BASE_URL }, sessionId);

    await waitFor('page de connexion (le serveur tourne-t-il ?)', 15_000, () =>
        evaluate<boolean>(
            `document.querySelector('input[placeholder*="utilisateur"]') !== null` +
                ` || document.querySelector('[class*="profileBtn"]') !== null`
        )
    );

    if (!(await exists('[class*="profileBtn"]'))) {
        if (!(await setInput('input[placeholder*="utilisateur"]', USERNAME))) {
            fail('connexion', 'champ « Nom d’utilisateur » introuvable');
        }
        await setInput('input[type="password"]', PASSWORD);
        // Plusieurs tentatives espacées : le rate limit global de l'API compte
        // aussi les visites précédentes (smoke relancé, curl de diagnostic).
        for (let attempt = 1; ; attempt++) {
            await evaluate(`document.querySelector('button.submit')?.click()`);
            const deadline = Date.now() + 8_000;
            while (Date.now() < deadline && !(await exists('[class*="profileBtn"]'))) await sleep(300);
            if (await exists('[class*="profileBtn"]')) break;
            if (attempt >= 4) {
                await waitFor('connexion (identifiants seedés valides ?)', 1, () => exists('[class*="profileBtn"]'));
            }
            await sleep(5_000);
        }
    }
    console.log('  ✓ connecté');

    // --- 2. la feature est dans le marché d'ajout ----------------------------
    await evaluate(`document.querySelector('[class*="profileBtn"]')?.click()`);
    await waitFor('menu du profil', 5_000, () => clickByText('Organiser l’accueil'));
    // Un accueil vierge (compte fraîchement seedé) n'a pas encore de section :
    // le bouton d'ajout de fonctionnalité n'existe que dans une section.
    await waitFor("mode organisation (bouton d'ajout)", 8_000, async () => {
        if (await clickByText('Ajouter une fonctionnalité')) return true;
        await clickByText('Ajouter une section');
        return false;
    });

    await waitFor(`« ${LABEL} » dans le marché d'ajout — la feature est-elle au catalogue ?`, 5_000, () =>
        evaluate<boolean>(`(() => {
            const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
            return [...document.querySelectorAll('button')].some((b) => norm(b.textContent).includes(${JSON.stringify(LABEL)}));
        })()`)
    );
    console.log('  ✓ au marché d’ajout');

    // Pose la tuile si elle ne l'est pas déjà (bouton désactivé = déjà posée).
    const placedNow = await evaluate<string>(`(() => {
        const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
        const btn = [...document.querySelectorAll('button')].find((b) => norm(b.textContent).includes(${JSON.stringify(LABEL)}));
        if (!btn) return 'introuvable';
        if (btn.disabled) return 'déjà posée';
        btn.click();
        return 'posée';
    })()`);
    // Referme le marché s'il est resté ouvert (Échap), puis quitte le mode.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }, sessionId);
    await sleep(300);
    await clickByText('Terminer');
    console.log(`  ✓ tuile ${placedNow}`);

    // --- 3. une commande du module part ET répond ----------------------------
    await waitFor(
        `un aller-retour « ${PREFIX}* » sur le fil — les commandes du module sont-elles enregistrées côté client ?`,
        20_000,
        async () => roundTrips.length > 0
    );
    console.log(`  ✓ premier aller-retour: ${roundTrips[0]}`);

    // --- 4. la vue complète s'ouvre et recharge ------------------------------
    const before = roundTrips.length;
    await waitFor(`la tuile « ${LABEL} » sur la grille`, 10_000, () => clickByText(LABEL));
    await waitFor(
        `un aller-retour « ${PREFIX}* » depuis la vue complète`,
        20_000,
        async () => roundTrips.length > before
    );
    console.log(`  ✓ vue complète: ${roundTrips.slice(before).join(', ')}`);

    // --- verdict --------------------------------------------------------------
    if (refusedLocally > 0) {
        fail('registre des commandes', `${refusedLocally} refus local(aux) « Unknown command » en console`);
    }
    if (exceptions.length > 0) {
        fail('exceptions JS', exceptions.slice(0, 5).join('\n  '));
    }
    if (consoleErrors.length > 0) {
        console.warn(`  ⚠ ${consoleErrors.length} console.error (non bloquant):`);
        for (const line of consoleErrors.slice(0, 5)) console.warn(`    ${line.slice(0, 160)}`);
    }
    console.log(`\n✓ SMOKE OK — ${roundTrips.length} aller(s)-retour(s) ${PREFIX}*, 0 exception.`);
    cdp.close();
    cleanup();
    process.exit(0);
}

void main();
