import {
    err,
    loginChallengeRequestSchema,
    loginRequestSchema,
    loginResponseSchema,
    loginVerifyRequestSchema,
    ok,
    TRUSTED_BROWSER_DAYS,
    type LoginStep,
    type UserRow
} from '@deveye/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { randomBytes } from 'node:crypto';

import type { Database } from '@/db';
import { loginCodeMail } from '@/Services/accountMails';
import type { AuditLog } from '@/Services/AuditLog';
import { clearAttempts, recordFailedAttempt, type AttemptScope } from '@/Services/attempts';
import type Encryption from '@/Services/Encryption';
import { maintenance, MaintenanceError } from '@/Services/maintenance';
import { SecretKeyService } from '@/Services/SecretKeyService';
import { claimPendingDek, DEFAULT_DEK_GRACE_MS, rememberSessionDek, stashPendingDek } from '@/Services/SecureStore';
import { phoneContext } from '@/Services/sealContexts';
import { serverMail } from '@/Services/serverMail';
import { sms, SmsQuotaError } from '@/Services/sms';
import { totpContext } from '@/Services/sealContexts';
import { hashBackupCode, verifyTotp } from '@/Services/Totp';
import { sha256hex } from '@/Utils/hash';
import { hashPassword, needsRehash, verifyPassword } from './argon';
import { browserLabel } from './browserLabel';
import {
    clearLoginChallengeCookie,
    LOGIN_CHALLENGE_COOKIE,
    setLoginChallengeCookie,
    setTrustedBrowserCookie,
    TRUSTED_BROWSER_COOKIE
} from './cookies';
import { authTransport, federatedOriginOf } from './federation';
import { syncFederationCookie } from './federationCookie';
import { signLoginChallenge, verifyLoginChallenge } from './jwt';
import { loadUserBundle } from './loadUserBundle';
import { lockedOut } from './lockout';
import {
    abandonLoginChallenge,
    advanceLoginChallenge,
    completeLoginChallenge,
    findLoginChallenge,
    issueLoginCode,
    LOGIN_CHALLENGE_MAX_FAILURES,
    LOGIN_CODE_MAX_SENDS,
    LOGIN_CODE_RESEND_MS,
    matchesLoginCode,
    openLoginChallenge,
    type LoginChallenge
} from './loginChallenge';
import { maskEmail, maskPhone } from './mask';
import { issueSession } from './session';

interface LoginDeps {
    db: Database;
    crypt: Encryption;
    audit: AuditLog;
}

/** Comptes qu'un même navigateur peut se souvenir de connaître. */
const TRUSTED_TOKENS_PER_BROWSER = 4;

const STEP_LABELS: Record<LoginStep, string> = {
    email: 'code par mail',
    totp: 'code de l’application',
    sms: 'code par SMS'
};

/**
 * Un hachage Argon2id de même profil que les vrais, vérifié quand l'identifiant
 * n'existe pas : sans lui, un compte connu coûte une vérification Argon2 et un
 * inconnu rien, et le temps de réponse dit qui existe.
 */
const dummyHash: Promise<string> = hashPassword(randomBytes(32).toString('hex'));

/**
 * Resolve the grace window (ms) for a freshly logged-in user from their
 * configured re-auth interval. Mirrors the secrecy feature: `null` → server
 * default, otherwise seconds → ms. `0` means "never cache".
 */
function loginGraceMs(reAuthIntervalSeconds: number | null): number {
    return reAuthIntervalSeconds === null ? DEFAULT_DEK_GRACE_MS : reAuthIntervalSeconds * 1000;
}

/**
 * Unwrap the user's DEK at login so the imminent WS session starts already
 * unlocked. Returns `null` when there's nothing to pre-cache: feature off, a `0`
 * re-auth interval, or a password that no longer unwraps the DEK (never blocks
 * login). Only runs on a real login: a reload reuses the access cookie.
 */
async function unwrapDekForLogin(
    db: Database,
    crypt: Encryption,
    userId: number,
    password: string
): Promise<{ dek: Buffer; graceMs: number } | null> {
    const keys = new SecretKeyService(db, crypt);
    try {
        const row = await keys.ensureRow(userId);
        if (!keys.isPasswordWrapped(row)) return null;
        const user = await db.users.findById(userId);
        const graceMs = loginGraceMs(user?.re_auth_interval ?? null);
        if (graceMs <= 0) return null;
        const dek = await keys.unwrapWithPassword(row, password);
        // Le mot de passe est en main : une ligne dérivée sous un ancien profil
        // Argon2 monte au profil courant.
        if (keys.needsKdfUpgrade(row)) await keys.wrapWithPassword(userId, dek, password, 'keep', row);
        return { dek, graceMs };
    } catch {
        // A wrong-secret or any failure here must never break login; the user
        // will simply be prompted to unlock on first encrypted access.
        return null;
    }
}

/** L'origine fédérée d'une connexion, pour que l'audit dise d'où elle a été ouverte. */
function federatedMetadata(req: FastifyRequest): { federatedOrigin: string } | Record<string, never> {
    const origin = federatedOriginOf(req);
    return origin ? { federatedOrigin: origin } : {};
}

/** La connexion en cours : un cookie pour notre page, le corps pour une origine fédérée. */
function readChallengeToken(req: FastifyRequest): string | undefined {
    if (authTransport(req) === 'cookie') return req.cookies[LOGIN_CHALLENGE_COOKIE];
    const parsed = loginChallengeRequestSchema.safeParse(req.body);
    return parsed.success ? parsed.data.challenge : undefined;
}

function dropChallengeCookie(req: FastifyRequest, reply: FastifyReply): void {
    if (authTransport(req) === 'cookie') clearLoginChallengeCookie(reply);
}

/** Les jetons de confiance que ce navigateur présente : son cookie, ou le corps d'une origine fédérée. */
function trustTokensOf(req: FastifyRequest): string[] {
    if (authTransport(req) === 'bearer') {
        const parsed = loginRequestSchema.safeParse(req.body);
        return parsed.success && parsed.data.trustToken ? [parsed.data.trustToken] : [];
    }
    const raw = req.cookies[TRUSTED_BROWSER_COOKIE] ?? '';
    return raw
        .split('.')
        .filter((t) => /^[\w-]{20,64}$/.test(t))
        .slice(-TRUSTED_TOKENS_PER_BROWSER);
}

const trustExpiry = (now: number): number => now + TRUSTED_BROWSER_DAYS * 86400;

export async function loginRoutes(app: FastifyInstance, { db, crypt, audit }: LoginDeps): Promise<void> {
    /**
     * Ce navigateur est-il de confiance pour ce compte ? Sa confiance repart
     * pour un tour, et son cookie perd au passage les jetons qui ne valent
     * plus rien.
     */
    const recognize = async (req: FastifyRequest, reply: FastifyReply, userId: number): Promise<boolean> => {
        const tokens = trustTokensOf(req);
        if (tokens.length === 0) return false;
        const now = Math.floor(Date.now() / 1000);
        const rows = await db.trustedBrowsers.findValid(tokens.map(sha256hex), now);
        const mine = rows.find((r) => r.user_id === userId);
        if (mine) await db.trustedBrowsers.touch(mine.id, now, trustExpiry(now));
        if (authTransport(req) === 'cookie') {
            const valid = new Set(rows.map((r) => r.token_hash));
            setTrustedBrowserCookie(
                reply,
                tokens.filter((t) => valid.has(sha256hex(t)))
            );
        }
        return mine !== undefined;
    };

    /** Fait confiance à ce navigateur ; rend le jeton à une origine fédérée, qui le garde elle-même. */
    const trust = async (req: FastifyRequest, reply: FastifyReply, userId: number): Promise<string | undefined> => {
        const token = randomBytes(32).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        await db.trustedBrowsers.create({
            userId,
            tokenHash: sha256hex(token),
            label: browserLabel(req.headers['user-agent']),
            now,
            expiresAt: trustExpiry(now)
        });
        if (authTransport(req) === 'bearer') return token;
        // Les jetons des autres comptes de ce navigateur restent ; le sien est remplacé.
        const others = trustTokensOf(req);
        const rows = await db.trustedBrowsers.findValid(others.map(sha256hex), now);
        const kept = others.filter((t) => rows.some((r) => r.token_hash === sha256hex(t) && r.user_id !== userId));
        setTrustedBrowserCookie(reply, [...kept, token].slice(-TRUSTED_TOKENS_PER_BROWSER));
        return undefined;
    };

    /** Ce qu'une connexion de ce compte doit franchir après le mot de passe, dans l'ordre. */
    const stepsFor = async (user: UserRow, trusted: boolean): Promise<LoginStep[]> => {
        const steps: LoginStep[] = [];
        if (!trusted && user.login_email_check === 1 && serverMail.configured) steps.push('email');
        if ((await db.twoFactor.get(user.id))?.enabled) steps.push('totp');
        if (!trusted && sms.available && (await db.userPhones.get(user.id))?.sms_check === 1) steps.push('sms');
        return steps;
    };

    /**
     * Le code par mail, dès que l'étape s'ouvre. Un serveur de mail en panne ne
     * ferme pas la porte à tous les comptes : l'étape est sautée, et l'instance
     * doit le corriger.
     */
    const mailCode = async (req: FastifyRequest, challenge: LoginChallenge, user: UserRow): Promise<boolean> => {
        const code = issueLoginCode(crypt, challenge);
        try {
            await serverMail.send(
                user.email,
                loginCodeMail({
                    username: user.username,
                    code,
                    browser: browserLabel(req.headers['user-agent']),
                    ip: req.ip,
                    at: Math.floor(Date.now() / 1000)
                })
            );
            return true;
        } catch (e) {
            req.log.error({ err: (e as Error).message, userId: user.id }, 'Code de connexion non envoyé');
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.emailCodeFailed',
                level: 'warning',
                uid: user.id,
                ip: req.ip,
                description: 'Code de connexion non envoyé (serveur de mail en panne) : étape sautée'
            });
            return false;
        }
    };

    /**
     * Le code par SMS, dès que l'étape s'ouvre : `skipped` quand le service
     * d'envoi est en panne (même règle que le mail), `quota` quand ce compte
     * ou cette adresse a épuisé ses SMS du jour (la connexion s'arrête alors :
     * seul qui a franchi le reste peut en être là).
     */
    const textCode = async (
        req: FastifyRequest,
        challenge: LoginChallenge,
        user: UserRow
    ): Promise<{ to: string } | 'skipped' | 'quota'> => {
        const row = await db.userPhones.get(user.id);
        const phone = row ? crypt.openTextFor('phone', row.phone_sealed, phoneContext(user.id)) : null;
        if (!phone) {
            req.log.error({ userId: user.id }, 'Numéro de téléphone illisible : étape SMS sautée');
            return 'skipped';
        }
        const code = issueLoginCode(crypt, challenge);
        try {
            await sms.send(
                phone,
                `DevEye : votre code de connexion est ${code}. Il expire dans 10 minutes. Ne le donnez à personne.`,
                { userId: user.id, ip: req.ip }
            );
            return { to: maskPhone(phone) };
        } catch (e) {
            if (e instanceof SmsQuotaError) return 'quota';
            req.log.error({ err: (e as Error).message, userId: user.id }, 'Code de connexion par SMS non envoyé');
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.smsCodeFailed',
                level: 'warning',
                uid: user.id,
                ip: req.ip,
                description: 'Code de connexion par SMS non envoyé (service d’envoi en panne) : étape sautée'
            });
            return 'skipped';
        }
    };

    const signIn = async (
        req: FastifyRequest,
        reply: FastifyReply,
        user: UserRow,
        opts: { dek: { dek: Buffer; graceMs: number } | null; trust: boolean; passed: LoginStep[]; trusted: boolean }
    ): Promise<FastifyReply> => {
        await db.users.updateLastLogin(user.id, Math.floor(Date.now() / 1000));
        const bundle = await loadUserBundle(db, user.id);
        if (!bundle) return reply.code(500).send(err('internal', 'Unable to load user'));
        const { sessionId, tokens } = await issueSession(reply, db, user.id, authTransport(req));
        await db.loginHistory.record({
            userId: user.id,
            sessionId,
            label: browserLabel(req.headers['user-agent']),
            ip: req.ip,
            steps: opts.passed,
            trusted: opts.trusted,
            now: Math.floor(Date.now() / 1000)
        });
        syncFederationCookie(req, reply, bundle);
        if (opts.dek) rememberSessionDek(sessionId, user.id, opts.dek.dek, opts.dek.graceMs);
        const trustToken = opts.trust ? await trust(req, reply, user.id) : undefined;
        const factors = opts.passed.map((s) => STEP_LABELS[s]);
        audit.record({
            source: 'web',
            category: 'auth',
            action: 'login.success',
            level: 'info',
            uid: user.id,
            ip: req.ip,
            description: factors.length
                ? `Connexion réussie : ${user.username} (${factors.join(', ')})`
                : `Connexion réussie : ${user.username}${opts.trusted ? ' (navigateur de confiance)' : ''}`,
            metadata: {
                steps: opts.passed,
                trustedBrowser: opts.trusted,
                ...(opts.trust ? { trusted: true } : {}),
                ...federatedMetadata(req)
            }
        });
        return reply.send(
            ok(
                loginResponseSchema.parse({
                    status: 'signedIn',
                    ...bundle,
                    tokens,
                    ...(trustToken ? { trustToken } : {})
                })
            )
        );
    };

    /** L'étape en cours, son code envoyé s'il en a un ; la session quand il n'en reste aucune. */
    const proceed = async (
        req: FastifyRequest,
        reply: FastifyReply,
        challenge: LoginChallenge,
        user: UserRow,
        token: string
    ): Promise<FastifyReply> => {
        const bearer = authTransport(req) === 'bearer';
        while (challenge.steps.length > 0) {
            const step = challenge.steps[0];
            let to: string | undefined;
            if (step === 'email') {
                if (!(await mailCode(req, challenge, user))) {
                    advanceLoginChallenge(challenge, false);
                    continue;
                }
                to = maskEmail(user.email);
            } else if (step === 'sms') {
                const sent = await textCode(req, challenge, user);
                if (sent === 'skipped') {
                    advanceLoginChallenge(challenge, false);
                    continue;
                }
                if (sent === 'quota') {
                    abandonLoginChallenge(challenge);
                    dropChallengeCookie(req, reply);
                    return reply.code(429).send(err('rate_limited', new SmsQuotaError().message));
                }
                to = sent.to;
            }
            return reply.send(
                ok(
                    loginResponseSchema.parse({
                        status: 'pending',
                        step,
                        ...(to ? { to } : {}),
                        ...(bearer ? { challenge: token } : {})
                    })
                )
            );
        }
        completeLoginChallenge(challenge);
        dropChallengeCookie(req, reply);
        const dek = challenge.pendingDekToken ? claimPendingDek(challenge.pendingDekToken) : null;
        return signIn(req, reply, user, { dek, trust: challenge.trust, passed: challenge.passed, trusted: false });
    };

    /** La connexion en cours que nomme la requête, et son compte ; sinon le refus déjà envoyé. */
    const resolve = async (
        req: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ challenge: LoginChallenge; user: UserRow; token: string } | FastifyReply> => {
        const token = readChallengeToken(req);
        if (!token) return reply.code(401).send(err('auth_required', 'Aucune connexion en cours'));
        const claims = await verifyLoginChallenge(token);
        const challenge = claims ? findLoginChallenge(claims.challengeId, claims.userId) : null;
        if (!challenge) {
            dropChallengeCookie(req, reply);
            return reply.code(401).send(err('auth_expired', 'Connexion expirée : recommencez'));
        }
        const user = await db.users.findById(challenge.userId);
        if (!user || user.status === 'suspended') {
            abandonLoginChallenge(challenge);
            dropChallengeCookie(req, reply);
            return reply.code(403).send(err('forbidden', 'Ce compte est suspendu. Contactez un administrateur.'));
        }
        return { challenge, user, token };
    };

    /** Le code de l'application, ou un code de secours, comme partout ailleurs. */
    const acceptTotp = async (userId: number, code: string): Promise<boolean | null> => {
        const twoFa = await db.twoFactor.get(userId);
        // Retirée entre deux étapes : il n'y a plus rien à prouver ici.
        if (!twoFa?.enabled) return null;
        const secret = crypt.openTextFor('totp', twoFa.secret_enc, totpContext(userId));
        const step = secret ? verifyTotp(code, secret, twoFa.last_used_counter) : null;
        if (step !== null && (await db.twoFactor.claimTotpCounter(userId, step))) return true;
        const backup = await db.twoFactor.findUnusedBackupCode(userId, hashBackupCode(crypt, code));
        return backup !== null && (await db.twoFactor.markBackupCodeUsed(backup.id));
    };

    app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
        const parsed = loginRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send(err('validation', 'Invalid login payload', parsed.error.flatten()));
        }
        const { username, password } = parsed.data;
        // Verrouillé par identifiant, connu ou non : la réponse reste la même.
        const attemptKey = username.trim().toLowerCase();
        const locked = lockedOut(reply, 'login', attemptKey);
        if (locked) return locked;

        const row = await db.users.findByUsername(username);
        if (!row) {
            await verifyPassword(await dummyHash, password);
            recordFailedAttempt('login', attemptKey);
            // L'identifiant saisi n'est pas gardé tel quel : on y tape souvent
            // son mot de passe par erreur, et l'audit se lit par tout administrateur.
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.failed',
                level: 'warning',
                uid: 0,
                ip: req.ip,
                description: 'Échec de connexion : identifiant inconnu',
                metadata: {
                    usernameRef: sha256hex(attemptKey).slice(0, 16),
                    usernameLength: username.length,
                    reason: 'unknown_user'
                }
            });
            return reply.code(401).send(err('auth_invalid', 'Invalid credentials'));
        }

        const valid = row.password_hash ? await verifyPassword(row.password_hash, password) : false;
        if (!valid) {
            recordFailedAttempt('login', attemptKey);
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.failed',
                level: 'warning',
                uid: row.id,
                ip: req.ip,
                description: `Échec de connexion : mot de passe incorrect pour « ${username} »`,
                metadata: { username, reason: 'bad_password' }
            });
            return reply.code(401).send(err('auth_invalid', 'Invalid credentials'));
        }

        clearAttempts('login', attemptKey);

        // Le compte est suspendu : identifiants corrects, mais pas d'accès. On le
        // vérifie APRÈS le mot de passe, pour ne pas révéler l'existence d'un
        // compte à qui n'en connaît pas les identifiants.
        if (row.status === 'suspended') {
            audit.record({
                source: 'web',
                category: 'auth',
                action: 'login.suspended',
                level: 'warning',
                uid: row.id,
                ip: req.ip,
                description: `Connexion refusée : compte suspendu « ${username} »`,
                metadata: { username }
            });
            return reply.code(403).send(err('forbidden', 'Ce compte est suspendu. Contactez un administrateur.'));
        }

        // Avant les codes : pendant la maintenance du site, un code saisi pour rien.
        if (maintenance.siteDown() && row.role !== 'admin') throw new MaintenanceError(maintenance.message());

        // Transparently upgrade legacy (bcrypt) hashes to argon2 after a successful login.
        if (row.password_hash && needsRehash(row.password_hash)) {
            try {
                await db.users.updatePasswordHash(row.id, await hashPassword(password));
            } catch (e) {
                req.log.warn({ err: (e as Error).message, userId: row.id }, 'Password rehash failed');
            }
        }

        // Unwrap the DEK now, while we hold the password, so the session starts
        // unlocked (no double prompt). Skipped when the feature is off or the
        // user opted into per-action re-prompts.
        const pending = await unwrapDekForLogin(db, crypt, row.id, password);
        const trusted = await recognize(req, reply, row.id);
        const steps = await stepsFor(row, trusted);
        if (steps.length === 0) return signIn(req, reply, row, { dek: pending, trust: false, passed: [], trusted });

        // La session n'existe pas encore : la DEK attend côté serveur, sous un
        // jeton opaque que la connexion en cours garde.
        const pdkToken = pending ? stashPendingDek(row.id, pending.dek, pending.graceMs) : undefined;
        const challenge = openLoginChallenge(row.id, steps, pdkToken);
        const token = await signLoginChallenge(row.id, challenge.id);
        if (authTransport(req) === 'cookie') setLoginChallengeCookie(reply, token);
        audit.record({
            source: 'web',
            category: 'auth',
            action: 'login.challenge',
            level: 'info',
            uid: row.id,
            ip: req.ip,
            description: `Mot de passe validé pour « ${username} » ; en attente : ${steps.map((s) => STEP_LABELS[s]).join(', ')}`,
            metadata: { steps }
        });
        return proceed(req, reply, challenge, row, token);
    });

    app.post(
        '/api/auth/login/verify',
        {
            config: {
                rateLimit: {
                    max: 10,
                    timeWindow: '5 minutes',
                    // Par connexion en cours et non par adresse : c'est elle qu'on
                    // devine. Une origine fédérée, dont le défi voyage dans le
                    // corps, est comptée par adresse.
                    keyGenerator: (req: FastifyRequest) => sha256hex(req.cookies[LOGIN_CHALLENGE_COOKIE] ?? req.ip)
                }
            }
        },
        async (req, reply) => {
            const parsed = loginVerifyRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return reply.code(400).send(err('validation', 'Invalid code payload', parsed.error.flatten()));
            }
            const resolved = await resolve(req, reply);
            if (!('challenge' in resolved)) return resolved;
            const { challenge, user, token } = resolved;

            const step = challenge.steps[0];
            const scope: AttemptScope = step === 'totp' ? 'twofa' : 'logincode';
            const key = String(user.id);
            const locked = lockedOut(reply, scope, key);
            if (locked) return locked;

            const code = parsed.data.code.trim();
            const accepted =
                step === 'totp' ? await acceptTotp(user.id, code) : matchesLoginCode(crypt, challenge, code);
            if (accepted === null) {
                advanceLoginChallenge(challenge, false);
                return proceed(req, reply, challenge, user, token);
            }
            if (!accepted) {
                recordFailedAttempt(scope, key);
                challenge.failures += 1;
                // Une connexion ne se devine pas un quart d'heure durant : passé
                // le seuil elle tombe, et la DEK mise de côté avec elle.
                const exhausted = challenge.failures >= LOGIN_CHALLENGE_MAX_FAILURES;
                if (exhausted) {
                    abandonLoginChallenge(challenge);
                    dropChallengeCookie(req, reply);
                }
                audit.record({
                    source: 'web',
                    category: 'auth',
                    action: exhausted ? 'login.codeLocked' : 'login.codeFailed',
                    level: 'warning',
                    uid: user.id,
                    ip: req.ip,
                    description: exhausted
                        ? `Échec de connexion : trop de codes faux (${STEP_LABELS[step]}), connexion annulée`
                        : `Échec de connexion : ${STEP_LABELS[step]} incorrect`,
                    metadata: { step }
                });
                return exhausted
                    ? reply.code(401).send(err('auth_expired', 'Trop de codes faux : recommencez la connexion'))
                    : reply.code(401).send(err('auth_invalid', 'Code incorrect'));
            }

            clearAttempts(scope, key);
            if (step !== 'totp' && parsed.data.trust) challenge.trust = true;
            advanceLoginChallenge(challenge);
            return proceed(req, reply, challenge, user, token);
        }
    );

    /** Un nouveau code pour l'étape en cours, quand elle en envoie un. */
    app.post(
        '/api/auth/login/resend',
        { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
        async (req, reply) => {
            const resolved = await resolve(req, reply);
            if (!('challenge' in resolved)) return resolved;
            const { challenge, user, token } = resolved;
            if (challenge.steps[0] === 'totp') {
                return reply.code(400).send(err('validation', 'Ce code vient de votre application'));
            }
            const wait = challenge.sentAt + LOGIN_CODE_RESEND_MS - Date.now();
            if (wait > 0) {
                return reply
                    .code(429)
                    .header('retry-after', Math.ceil(wait / 1000))
                    .send(err('rate_limited', 'Patientez avant de redemander un code', { retryAfterMs: wait }));
            }
            if (challenge.sends >= LOGIN_CODE_MAX_SENDS) {
                abandonLoginChallenge(challenge);
                dropChallengeCookie(req, reply);
                return reply.code(401).send(err('auth_expired', 'Trop de codes demandés : recommencez la connexion'));
            }
            return proceed(req, reply, challenge, user, token);
        }
    );

    /**
     * Abandon an in-progress login: clear the cookie and release any DEK
     * stashed at the password step. Always succeeds, so the client can call it
     * unconditionally.
     */
    app.post('/api/auth/login/cancel', async (req, reply) => {
        const token = readChallengeToken(req);
        const claims = token ? await verifyLoginChallenge(token) : null;
        const challenge = claims ? findLoginChallenge(claims.challengeId, claims.userId) : null;
        if (challenge) abandonLoginChallenge(challenge);
        dropChallengeCookie(req, reply);
        return reply.send(ok({ cancelled: true as const }));
    });
}
