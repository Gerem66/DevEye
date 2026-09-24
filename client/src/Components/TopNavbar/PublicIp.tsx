import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { copyText } from '@/copyText';
import styles from './PublicIp.module.css';

/**
 * Mini-widget « Mon IP » : l'adresse publique par laquelle CE navigateur sort,
 * en IPv4 ou en IPv6 au choix.
 *
 * Seul endroit du client qui appelle un tiers en direct au lieu de passer par
 * une commande, et c'est la seule façon d'avoir la bonne réponse : `req.ip`
 * n'est l'adresse publique du client que si l'instance est jointe par Internet
 * (par un VPN ou le réseau local, c'est une adresse privée), et un appel
 * sortant depuis le serveur donnerait l'IP de sortie du serveur.
 *
 * Le magasin vit au-dessus du composant : l'éditeur de topbar monte un aperçu
 * vivant en même temps que la barre, et deux copies ne doivent pas faire deux
 * appels.
 */

const TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 4000;
const FAMILY_KEY = 'deveye:publicIp:family';

export type IpFamily = 'v4' | 'v6';

/**
 * Une famille se force par l'hôte interrogé, pas par un paramètre : `api6` n'a
 * qu'un AAAA, `api` qu'un A. Un échec dit donc quelque chose de vrai, que cette
 * connexion n'a pas d'adresse de cette famille.
 */
const SOURCES: Record<IpFamily, { json: string; text: string }> = {
    v4: { json: 'https://api.ipify.org?format=json', text: 'https://ipv4.icanhazip.com' },
    v6: { json: 'https://api6.ipify.org?format=json', text: 'https://ipv6.icanhazip.com' }
};

export interface IpReading {
    ip: string;
    country: string | null;
    /** Le drapeau du pays, en SVG. `null` quand l'enrichissement n'a rien donné. */
    flag: string | null;
    isp: string | null;
}

export interface PublicIpState {
    family: IpFamily;
    reading: IpReading | null;
    loading: boolean;
    failed: boolean;
}

interface Slot {
    reading: IpReading | null;
    failed: boolean;
    fetchedAt: number;
    inFlight: Promise<void> | null;
}

interface IpWhoIs {
    success?: boolean;
    country?: string;
    flag?: { img?: string };
    connection?: { isp?: string; org?: string };
}

function loadFamily(): IpFamily {
    try {
        return localStorage.getItem(FAMILY_KEY) === 'v6' ? 'v6' : 'v4';
    } catch {
        // Navigation privée, stockage refusé : l'IPv4 par défaut.
        return 'v4';
    }
}

const slots: Record<IpFamily, Slot> = {
    v4: { reading: null, failed: false, fetchedAt: 0, inFlight: null },
    v6: { reading: null, failed: false, fetchedAt: 0, inFlight: null }
};
let family: IpFamily = loadFamily();
let loading = true;
const listeners = new Set<() => void>();
let snapshot: PublicIpState = { family, reading: null, loading: true, failed: false };
let refCount = 0;
let detach: (() => void) | null = null;

function emit(): void {
    const slot = slots[family];
    snapshot = { family, reading: slot.reading, loading, failed: slot.failed };
    for (const fn of listeners) fn();
}

/** L'adresse de la famille demandée, ipify puis icanhazip en repli. */
async function readAddress(f: IpFamily): Promise<string> {
    const source = SOURCES[f];
    try {
        const res = await fetch(source.json, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const body = (await res.json()) as { ip?: string };
        if (res.ok && body.ip) return body.ip;
    } catch {
        // Source injoignable ou réponse illisible : le repli tranche.
    }
    const res = await fetch(source.text, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    if (text.length === 0) throw new Error('réponse sans adresse');
    return text;
}

/** Le pays, son drapeau et le fournisseur. Facultatif : sans eux l'adresse suffit. */
async function enrich(ip: string): Promise<Omit<IpReading, 'ip'>> {
    try {
        const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const body = (await res.json()) as IpWhoIs;
        if (!res.ok || body.success === false) throw new Error('sans réponse');
        return {
            country: body.country ?? null,
            flag: body.flag?.img ?? null,
            isp: body.connection?.isp ?? body.connection?.org ?? null
        };
    } catch {
        return { country: null, flag: null, isp: null };
    }
}

function refresh(f: IpFamily, force = false): void {
    const slot = slots[f];
    if (slot.inFlight) return;
    if (!force && slot.reading !== null && Date.now() - slot.fetchedAt < TTL_MS) return;
    if (f === family) {
        loading = true;
        emit();
    }
    slot.inFlight = readAddress(f)
        .then(async (ip) => {
            const extra = await enrich(ip);
            slot.reading = { ip, ...extra };
            slot.failed = false;
            slot.fetchedAt = Date.now();
        })
        .catch(() => {
            // Un échec passager garde la dernière adresse connue plutôt que de
            // la remplacer par un tiret trompeur.
            slot.failed = slot.reading === null;
        })
        .finally(() => {
            slot.inFlight = null;
            if (f === family) loading = false;
            emit();
        });
}

/** Bascule entre IPv4 et IPv6, et retient le choix pour ce navigateur. */
export function setIpFamily(next: IpFamily): void {
    if (next === family) return;
    family = next;
    try {
        localStorage.setItem(FAMILY_KEY, next);
    } catch {
        // Stockage refusé : le choix ne vaut que pour cette session.
    }
    loading = slots[next].reading === null;
    emit();
    refresh(next);
}

function start(): void {
    refCount += 1;
    if (refCount > 1) return;
    refresh(family);
    const onOnline = (): void => refresh(family, true);
    const onVisible = (): void => {
        if (document.visibilityState === 'visible') refresh(family);
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    detach = () => {
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisible);
    };
}

function stop(): void {
    refCount -= 1;
    if (refCount > 0) return;
    refCount = 0;
    detach?.();
    detach = null;
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): PublicIpState {
    return snapshot;
}

export function usePublicIp(): PublicIpState {
    const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    useEffect(() => {
        start();
        return stop;
    }, []);
    return snap;
}

/** Le seuil d'activation du glisser de l'éditeur (`PointerSensor`), en pixels. */
const DRAG_SLOP_PX = 8;

const OTHER: Record<IpFamily, IpFamily> = { v4: 'v6', v6: 'v4' };
const FAMILY_LABEL: Record<IpFamily, string> = { v4: 'IPv4', v6: 'IPv6' };

/**
 * `editing` : en mode organisation, le clic bascule de famille au lieu de
 * copier. C'est là que se règle la barre, et le seul réglage que ce widget ait.
 */
export function PublicIp({ editing = false }: { editing?: boolean }) {
    const { family: shown, reading, failed } = usePublicIp();
    const [copied, setCopied] = useState(false);
    const [flagBroken, setFlagBroken] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const downAt = useRef<{ x: number; y: number } | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        },
        []
    );

    // Un drapeau cassé l'est pour une adresse donnée : changer de famille, ou
    // de réseau, mérite un nouvel essai.
    useEffect(() => setFlagBroken(false), [reading?.flag]);

    const copy = (): void => {
        if (reading === null) return;
        void copyText(reading.ip).then((ok) => {
            // Presse-papiers refusé (permission) : rien à dire.
            if (!ok) return;
            setCopied(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setCopied(false), 2000);
        });
    };

    const label = reading?.ip ?? (failed ? '—' : '…');
    const where = reading === null ? '' : [reading.isp, reading.country].filter((s) => s !== null).join(' · ');
    const title = editing
        ? `Affiche l’${FAMILY_LABEL[shown]} — cliquer pour passer en ${FAMILY_LABEL[OTHER[shown]]}`
        : copied
          ? 'Copié !'
          : reading === null
            ? failed
                ? `Aucune adresse ${FAMILY_LABEL[shown]} obtenue`
                : `Adresse ${FAMILY_LABEL[shown]} publique`
            : `Adresse ${FAMILY_LABEL[shown]} publique${where ? ` · ${where}` : ''} — cliquer pour copier`;

    const flag = reading?.flag ?? null;
    const showFlag = !editing && !copied && flag !== null && !flagBroken;

    return (
        <button
            type='button'
            className={`${styles.pill} ${editing ? styles.editing : ''}`}
            title={title}
            aria-label={
                editing
                    ? `Adresse ${FAMILY_LABEL[shown]}, basculer en ${FAMILY_LABEL[OTHER[shown]]}`
                    : reading === null
                      ? `Adresse ${FAMILY_LABEL[shown]} publique`
                      : `Adresse ${FAMILY_LABEL[shown]} publique ${reading.ip}, cliquer pour copier`
            }
            disabled={!editing && reading === null}
            // Le clic ne doit pas voler son geste au glisser-réordonner, qui part
            // du chip entier : seul un pointeur qui n'a pas bougé bascule.
            onPointerDown={(e) => {
                downAt.current = { x: e.clientX, y: e.clientY };
            }}
            onClick={(e) => {
                const from = downAt.current;
                downAt.current = null;
                if (editing && from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP_PX) return;
                if (editing) setIpFamily(OTHER[shown]);
                else copy();
            }}
        >
            {showFlag ? (
                <img
                    className={styles.flag}
                    src={flag}
                    alt=''
                    /* Drapeau injoignable : l'icône reprend la place. */
                    onError={() => setFlagBroken(true)}
                />
            ) : (
                <span className={`icon ${copied ? 'icon-square-check' : 'icon-globe'} ${styles.icon}`} />
            )}
            <span className={styles.value}>{label}</span>
        </button>
    );
}
