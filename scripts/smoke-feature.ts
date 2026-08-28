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
 *   npm run smoke:feature -- <featureId> <label> [--url=http://localhost:3000] [--headed]
 *   npm run smoke:feature -- osint OSINT
 *   npm run smoke:feature -- weather Météo
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
    console.error('Usage: npm run smoke:feature -- <featureId> <label> [--url=...] [--headed]');
    process.exit(2);
}
const BASE_URL = flags.get('url') ?? 'http://localhost:3000';
const HEADED = flags.has('headed');
const USERNAME = process.env.SMOKE_USERNAME ?? 'dev';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'devdevdev';
const BROWSER = process.env.SMOKE_BROWSER ?? 'chromium-browser';
/** Le préfixe des commandes du module (casse historique tolérée : cloudSync.*). */
const PREFIX = `${FEATURE.toLowerCase()}.`;
/** La racine du dialogue du marché d'ajout (le composant `Dialog` de l'app). */
const MARKET_SELECTOR = '[role="dialog"]';

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

/** Ce que la page affichait au moment d'un échec : rempli par `openPage` une
 *  fois la session CDP ouverte, pour que tout échec dise CE QUE l'écran montrait. */
let dumpPageText: () => Promise<string> = () => Promise.resolve('');

/** La veille en cours, pour qu'un échec d'étape dise aussi CE QUE la console a vu. */
let currentWatch: Watch | null = null;

/** Les dernières exceptions et erreurs de console, mises en forme pour un échec. */
function consoleTail(): string {
    if (!currentWatch) return '';
    const lines = [
        ...currentWatch.exceptions.slice(-3).map((e) => `exception: ${e}`),
        ...currentWatch.consoleErrors.slice(-3).map((e) => `console.error: ${e}`)
    ];
    return lines.length > 0 ? `\n  ${lines.join('\n  ').replace(/\s+/g, ' ').slice(0, 1200)}` : '';
}

/** Attend qu'un prédicat (évalué en boucle) devienne vrai, sinon échoue en nommant l'étape. */
async function waitFor(step: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(200);
    }
    const shown = (await dumpPageText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
    fail(step, `délai de ${timeoutMs} ms dépassé\n  écran: ${shown}${consoleTail()}`);
}

// ------------------------------------------------------------------ la page pilotée

/** L'onglet piloté : sa session CDP et les gestes qu'on y fait, évalués dans la page. */
interface Page {
    cdp: Cdp;
    sessionId: string;
    /** Évalue une expression dans la page et rend sa valeur (JSON-compatible). */
    evaluate<T>(expression: string): Promise<T>;
    /** Un élément (bouton de préférence) portant exactement ce texte, cliqué. */
    clickByText(text: string): Promise<boolean>;
    /** Renseigne un input contrôlé par React (setter natif + événement input). */
    setInput(selector: string, value: string): Promise<boolean>;
    exists(selector: string): Promise<boolean>;
    /** Une touche pressée puis relâchée. */
    press(key: string): Promise<void>;
}

/** Ce que le scénario relève pendant qu'il se joue, pour le verdict. */
interface Watch {
    exceptions: string[];
    consoleErrors: string[];
    /** Allers-retours ACCOMPLIS (réponse ok) des commandes du module. */
    roundTrips: string[];
    /** Refus LOCAUX « Unknown command » : le bug historique, que seule la console trahit. */
    refusedLocally: number;
}

/** Lance Chromium sur un profil temporaire ; rend l'URL DevTools et de quoi tout nettoyer. */
async function launchBrowser(): Promise<{ wsUrl: string; cleanup: () => void }> {
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
    return { wsUrl, cleanup };
}

/** Ouvre un onglet, active les domaines CDP utiles et rend les gestes de page. */
async function openPage(wsUrl: string): Promise<Page> {
    const cdp = await Cdp.connect(wsUrl);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    const evaluate = async <T>(expression: string): Promise<T> => {
        const res = await cdp.send<{ result: { value: T } }>(
            'Runtime.evaluate',
            { expression, returnByValue: true },
            sessionId
        );
        return res.result.value;
    };
    dumpPageText = () => evaluate<string>(`document.body ? document.body.innerText : '(pas de body)'`);

    return {
        cdp,
        sessionId,
        evaluate,
        clickByText: (text) =>
            evaluate<boolean>(`(() => {
            const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
            const all = [...document.querySelectorAll('button, [role="button"], a, span, h3, div')];
            const hit = all.filter((el) => norm(el.textContent) === ${JSON.stringify(text)})
                .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0];
            if (!hit) return false;
            (hit.closest('button, [role="button"], a') ?? hit).click();
            return true;
        })()`),
        setInput: (selector, value) =>
            evaluate<boolean>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`),
        exists: (selector) => evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`),
        press: async (key) => {
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key }, sessionId);
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }, sessionId);
        }
    };
}

/** Collecte exceptions, console.error et trames WS de l'app, pour le verdict. */
function watchPage(page: Page): Watch {
    const watch: Watch = { exceptions: [], consoleErrors: [], roundTrips: [], refusedLocally: 0 };
    currentWatch = watch;
    /** requestId -> commande, pour les trames sorties portant le préfixe du module. */
    const sentByRequest = new Map<string, string>();

    page.cdp.on((e) => {
        if (e.sessionId !== page.sessionId) return;
        if (e.method === 'Runtime.exceptionThrown') {
            const d = e.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
            watch.exceptions.push(
                d.exceptionDetails?.exception?.description ?? d.exceptionDetails?.text ?? 'exception'
            );
        }
        if (e.method === 'Runtime.consoleAPICalled') {
            const d = e.params as { type?: string; args?: { value?: unknown; description?: string }[] };
            if (d.type === 'error') {
                const text = (d.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
                watch.consoleErrors.push(text);
                // Le bug historique : refus LOCAL avant la socket. Il ne produit
                // aucune trame, donc seule la console le trahit.
                if (text.includes('Unknown command')) watch.refusedLocally++;
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
                if (command && frame.payload?.ok === true) watch.roundTrips.push(command);
            } catch {
                /* idem */
            }
        }
    });
    return watch;
}

// ------------------------------------------------------------------ scénario

/** 1. L'app se charge et la connexion (compte seedé) aboutit. */
async function login(page: Page): Promise<void> {
    await page.cdp.send('Page.navigate', { url: BASE_URL }, page.sessionId);

    await waitFor('page de connexion (le serveur tourne-t-il ?)', 15_000, () =>
        page.evaluate<boolean>(
            `document.querySelector('input[placeholder*="utilisateur"]') !== null` +
                ` || document.querySelector('[class*="profileBtn"]') !== null`
        )
    );

    if (!(await page.exists('[class*="profileBtn"]'))) {
        // Re-remplir les DEUX champs à CHAQUE tentative : un échec de connexion
        // vide le mot de passe côté client, donc un simple re-clic soumettrait
        // du vide. Et le budget par tentative est large : la vérification du
        // mot de passe passe par argon2 (lent à dessein), et le premier login
        // après le seed, sur un runner froid et chargé, peut dépasser 10 s.
        for (let attempt = 1; ; attempt++) {
            if (!(await page.setInput('input[placeholder*="utilisateur"]', USERNAME))) {
                fail('connexion', 'champ « Nom d’utilisateur » introuvable');
            }
            await page.setInput('input[type="password"]', PASSWORD);
            await page.evaluate(`document.querySelector('button.submit')?.click()`);
            const deadline = Date.now() + 25_000;
            while (Date.now() < deadline && !(await page.exists('[class*="profileBtn"]'))) await sleep(300);
            if (await page.exists('[class*="profileBtn"]')) break;
            if (attempt >= 3) {
                await waitFor('connexion (identifiants seedés valides ?)', 1, () =>
                    page.exists('[class*="profileBtn"]')
                );
            }
            await sleep(3_000);
        }
    }
    console.log('  ✓ connecté');
}

/**
 * Le marché d'ajout, et lui seul : la carte d'une feature s'y cherche parmi SES
 * boutons, jamais parmi ceux de toute la page. Derrière le dialogue, la grille
 * porte les tuiles déjà posées, et l'une d'elles peut contenir le nom cherché
 * (« Appareils » est à la fois une feature et un mot que d'autres tuiles
 * écrivent). Une carte commence par son intitulé : `startsWith`, pas
 * `includes`, pour ne pas prendre une description pour un titre.
 */
const MARKET_ROOT_JS = `const marketRoot = () => document.querySelector(${JSON.stringify(MARKET_SELECTOR)}) ?? document;`;

/** 2. La feature est dans le marché d'ajout (mode organisation, bouton d'ajout d'une section). */
async function checkCatalogue(page: Page): Promise<void> {
    await page.evaluate(`document.querySelector('[class*="profileBtn"]')?.click()`);
    await waitFor('menu du profil', 5_000, () => page.clickByText('Organiser l’accueil'));
    // Un accueil vierge (compte fraîchement seedé) n'a pas encore de section :
    // le bouton d'ajout de fonctionnalité n'existe que dans une section.
    await waitFor("mode organisation (bouton d'ajout)", 8_000, async () => {
        if (await page.clickByText('Ajouter une fonctionnalité')) return true;
        await page.clickByText('Ajouter une section');
        return false;
    });

    await waitFor(`« ${LABEL} » dans le marché d'ajout — la feature est-elle au catalogue ?`, 5_000, () =>
        page.evaluate<boolean>(`(() => {
            ${MARKET_ROOT_JS}
            const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
            return [...marketRoot().querySelectorAll('button')].some((b) => norm(b.textContent).startsWith(${JSON.stringify(LABEL)}));
        })()`)
    );
    console.log('  ✓ au marché d’ajout');
}

/** Pose la tuile si elle ne l'est pas déjà (bouton désactivé = déjà posée), puis quitte le mode. */
async function placeTile(page: Page): Promise<void> {
    const placedNow = await page.evaluate<string>(`(() => {
        ${MARKET_ROOT_JS}
        const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
        const btn = [...marketRoot().querySelectorAll('button')].find((b) => norm(b.textContent).startsWith(${JSON.stringify(LABEL)}));
        if (!btn) return 'introuvable';
        if (btn.disabled) return 'déjà posée';
        btn.click();
        return 'posée';
    })()`);
    // Referme le marché s'il est resté ouvert (Échap), puis quitte le mode.
    await page.press('Escape');
    await sleep(300);
    await page.clickByText('Terminer');
    console.log(`  ✓ tuile ${placedNow}`);
}

/** 3. Une commande du module part sur le fil ET reçoit une réponse ok. */
async function awaitFirstRoundTrip(watch: Watch): Promise<void> {
    await waitFor(
        `un aller-retour « ${PREFIX}* » sur le fil — les commandes du module sont-elles enregistrées côté client ?`,
        20_000,
        async () => watch.roundTrips.length > 0
    );
    console.log(`  ✓ premier aller-retour: ${watch.roundTrips[0]}`);
}

/**
 * 4. La vue complète s'ouvre : elle déclenche un nouvel aller-retour, OU elle
 * est déjà là. Une vue `preload` (Appareils) est montée par l'accueil au repos
 * dès que sa tuile est posée, et a donc déjà parlé au serveur avant le clic :
 * la seule preuve qui reste est la barre du haut, qui porte le nom de la vue
 * ouverte. Les deux issues valent ; laquelle a tranché est dit.
 */
async function openFullView(page: Page, watch: Watch): Promise<void> {
    const before = watch.roundTrips.length;
    await waitFor(`la tuile « ${LABEL} » sur la grille`, 10_000, () => page.clickByText(LABEL));
    let opened = false;
    await waitFor(
        `la vue complète « ${LABEL} » (un aller-retour « ${PREFIX}* », ou son titre en barre du haut)`,
        20_000,
        async () => {
            if (watch.roundTrips.length > before) return true;
            opened = await page.evaluate<boolean>(`(() => {
            const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
            return [...document.querySelectorAll('[class*="viewTitle"]')].some((el) => norm(el.textContent) === ${JSON.stringify(LABEL)});
        })()`);
            return opened;
        }
    );
    const fresh = watch.roundTrips.slice(before);
    console.log(
        `  ✓ vue complète: ${fresh.length > 0 ? fresh.join(', ') : 'déjà chargée (préchauffée), titre en barre du haut'}`
    );
}

/** Le verdict : un refus local ou une exception JS est un échec, un console.error un avertissement. */
function verdict(watch: Watch): void {
    if (watch.refusedLocally > 0) {
        fail('registre des commandes', `${watch.refusedLocally} refus local(aux) « Unknown command » en console`);
    }
    if (watch.exceptions.length > 0) {
        fail('exceptions JS', watch.exceptions.slice(0, 5).join('\n  '));
    }
    if (watch.consoleErrors.length > 0) {
        console.warn(`  ⚠ ${watch.consoleErrors.length} console.error (non bloquant):`);
        for (const line of watch.consoleErrors.slice(0, 5)) console.warn(`    ${line.slice(0, 160)}`);
    }
    console.log(`\n✓ SMOKE OK — ${watch.roundTrips.length} aller(s)-retour(s) ${PREFIX}*, 0 exception.`);
}

async function main(): Promise<void> {
    const { wsUrl, cleanup } = await launchBrowser();
    const page = await openPage(wsUrl);
    const watch = watchPage(page);

    console.log(`Smoke « ${FEATURE} » (${LABEL}) sur ${BASE_URL}`);
    await login(page);
    await checkCatalogue(page);
    await placeTile(page);
    await awaitFirstRoundTrip(watch);
    await openFullView(page, watch);
    verdict(watch);

    page.cdp.close();
    cleanup();
    process.exit(0);
}

void main();
