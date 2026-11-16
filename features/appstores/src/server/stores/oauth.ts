import { storeHttp, STORE_TIMEOUT_MS } from './types';

/**
 * L'échange d'un jeton chez Google, recopié de `postToken` du module Mail : un
 * module n'importe pas un autre module. L'adresse est écrite en dur : le
 * `token_uri` du JSON d'un compte de service viendrait de l'utilisateur.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface TokenResponse {
    access_token: string;
    /** Non vérifié : la réponse se parse, elle ne se type pas. */
    expires_in?: unknown;
    error?: string;
    error_description?: string;
}

/**
 * Les seuls refus définitifs (RFC 6749 §5.2) : la clé supprimée, le compte
 * désactivé, le client ou la portée refusés. Le reste passe pour transitoire.
 */
const PERMANENT_TOKEN_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope']);

/**
 * Un refus du point d'échange. Le verdict lit le code OAuth, jamais le
 * statut : Google répond 400 à `invalid_grant` comme à `rate_limit_exceeded`.
 */
export class OAuthTokenError extends Error {
    readonly permanent: boolean;

    constructor(
        readonly status: number | null,
        readonly code: string | null,
        message: string,
        cause?: unknown
    ) {
        super(message);
        this.name = 'OAuthTokenError';
        this.permanent = code !== null && PERMANENT_TOKEN_ERRORS.has(code);
        if (cause !== undefined) this.cause = cause;
    }
}

export async function postToken(body: URLSearchParams, signal?: AbortSignal): Promise<TokenResponse> {
    const timeout = AbortSignal.timeout(STORE_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
        res = await storeHttp.fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': 'DevEye' },
            body: body.toString(),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        });
        // Le texte d'abord : une passerelle en panne répond du HTML, et
        // `res.json()` perdrait le statut comme le code OAuth.
        text = await res.text();
    } catch (e) {
        if (signal?.aborted) throw e;
        throw new OAuthTokenError(null, null, 'Le point d’échange des jetons de Google ne répond pas.', e);
    }

    let json: TokenResponse | null;
    try {
        json = JSON.parse(text) as TokenResponse;
    } catch {
        json = null;
    }
    if (!res.ok || !json?.access_token) {
        const code = typeof json?.error === 'string' ? json.error : null;
        const detail = json?.error_description ?? (json === null ? text.slice(0, 200).trim() : null);
        throw new OAuthTokenError(
            res.status,
            code,
            `Le point d’échange des jetons a répondu ${res.status}` +
                (code ? ` (${code})` : '') +
                (detail ? ` : ${detail}` : '')
        );
    }
    return json;
}
