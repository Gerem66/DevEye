/**
 * Ce qu'on lit d'un user-agent : navigateur, système, type d'appareil, et rien
 * de plus. Le reste (version exacte, moteur de rendu) découpe l'audience en
 * tranches dont on ne tire rien. Pur et sans dépendance : ici, se tromper met
 * une visite dans « Autre », ce qui est exactement ce que « Autre » veut dire.
 *
 * L'ordre des tests est le sujet : ces chaînes mentent par héritage (Edge
 * contient « Chrome », Chrome contient « Safari »). On va du plus spécifique au
 * plus général, et changer cet ordre casse la détection sans casser un type.
 */

export interface UserAgentInfo {
    browser: string;
    os: string;
    /** `desktop`, `mobile` ou `tablet` : trois valeurs, pas une taxonomie. */
    device: string;
}

const UNKNOWN: UserAgentInfo = { browser: 'Autre', os: 'Autre', device: 'desktop' };

function detectBrowser(ua: string): string {
    // Du plus spécifique au plus général : chacun des quatre premiers se déclare aussi
    // « Chrome », et les cinq premiers se déclarent « Safari ».
    if (/\bEdg[A-Z]?\//.test(ua)) return 'Edge';
    if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
    if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
    if (/\bVivaldi\//.test(ua)) return 'Vivaldi';
    if (/\bBrave\//.test(ua)) return 'Brave';
    if (/\bChrome\/|\bCriOS\//.test(ua)) return 'Chrome';
    if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
    if (/\bSafari\//.test(ua)) return 'Safari';
    return 'Autre';
}

function detectOs(ua: string): string {
    // Android avant Linux : tout Android est un Linux et le dit.
    if (/\bAndroid\b/.test(ua)) return 'Android';
    // iPadOS 13+ se présente comme un Macintosh ; c'est `detectDevice` qui le rattrape.
    if (/\biPhone\b|\biPad\b|\biPod\b/.test(ua)) return 'iOS';
    if (/\bWindows NT\b/.test(ua)) return 'Windows';
    if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
    if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
    if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
    return 'Autre';
}

function detectDevice(ua: string): string {
    if (/\biPad\b/.test(ua)) return 'tablet';
    // Un Android sans « Mobile » est une tablette : la convention posée par Google,
    // et la seule distinction disponible dans la chaîne.
    if (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua)) return 'tablet';
    if (/\bTablet\b/i.test(ua)) return 'tablet';
    if (/\bMobi\b|\bMobile\b|\biPhone\b|\biPod\b/.test(ua)) return 'mobile';
    return 'desktop';
}

/** Une chaîne vide rend `Autre` partout, ce qui est la vérité, pas une erreur. */
export function parseUserAgent(raw: string | undefined): UserAgentInfo {
    const ua = (raw ?? '').trim();
    if (!ua) return { ...UNKNOWN };
    return { browser: detectBrowser(ua), os: detectOs(ua), device: detectDevice(ua) };
}

/**
 * Les robots connus, écartés de la mesure : un moteur qui passe six fois par
 * jour double les chiffres d'un site peu visité. Volontairement grossier, il
 * n'attrape que ce qui s'annonce comme robot ; la seule parade contre ceux qui
 * se déguisent serait une empreinte de navigateur, que ce système refuse.
 */
const BOT_PATTERN = /bot\b|crawler|spider|slurp|facebookexternalhit|preview|monitor|curl\/|wget\/|python-|headless/i;

export function looksLikeBot(raw: string | undefined): boolean {
    if (!raw) return false;
    return BOT_PATTERN.test(raw);
}
