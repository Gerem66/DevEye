/**
 * Le navigateur des tests de composants : jsdom, plus ce qu'il n'a pas et que
 * les composants appellent sans se poser de question.
 */
import { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
});

/** Aucune mise en page sous jsdom : un observateur n'a jamais rien à dire. */
class SilentObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
        return [];
    }
}

/** Rien ne sort du processus : la socket se remplace par `fakeServer()`, une requête HTTP échoue comme hors ligne. */
class NoSocket {
    constructor() {
        throw new Error('WebSocket : ce test parle au serveur sans avoir appelé fakeServer()');
    }
}

Object.assign(window, {
    ResizeObserver: SilentObserver,
    IntersectionObserver: SilentObserver,
    WebSocket: NoSocket,
    fetch: () => Promise.reject(new TypeError('fetch : pas de réseau dans les tests de composants')),
    matchMedia: (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false
    }),
    scrollTo() {}
});
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollTo = () => {};

// Les globales du document remplacent celles de Node (`navigator`, `Event`…),
// pour qu'un événement créé par un test soit de la famille de l'élément qui le
// reçoit. Les minuteries restent celles de Node, que `node:test` sait simuler.
const KEPT = /^(globalThis|window|self|top|parent|frames|console|crypto|performance|queueMicrotask|structuredClone)$/;
const TIMER = /^(set|clear)(Timeout|Interval|Immediate)$/;
for (const key of Object.getOwnPropertyNames(window)) {
    if (KEPT.test(key) || TIMER.test(key) || key in Object.prototype) continue;
    if (['undefined', 'NaN', 'Infinity'].includes(key)) continue;
    Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: window[key]
    });
}
globalThis.window = window;
globalThis.self = window;

// Posée par Vite (`define`) dans un vrai build.
globalThis.__APP_VERSION__ = '0.0.0';

// Une sortie animée garderait l'élément au DOM après sa fermeture.
const { MotionGlobalConfig } = await import('framer-motion');
MotionGlobalConfig.skipAnimations = true;

// Ce que la bibliothèque de test fait d'elle-même sous les lanceurs qu'elle reconnaît.
const { cleanup } = await import('@testing-library/react');
afterEach(() => cleanup());
