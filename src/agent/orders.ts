import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';

import { SIGNED_AGENT_COMMANDS } from '@deveye/types';

import { env } from '@/Utils/Env';

/**
 * La signature des ordres à fort impact. Un agent exécute ce qui lui arrive sur
 * sa socket : sans signature, quiconque tient cette socket (un proxy qui termine
 * le TLS, un jeton d'appareil volé et rejoué par un faux serveur) tient la
 * machine. La clé privée ne vit que dans l'environnement du serveur ; l'agent
 * épingle la clé publique à l'enrôlement et refuse tout ordre de
 * `SIGNED_AGENT_COMMANDS` qui ne la porte pas. Un serveur compromis avec sa clé
 * reste un serveur compromis : ce que la machine lui refuse se règle chez elle,
 * dans sa `[policy]`.
 */

/** L'en-tête DER d'une clé privée Ed25519 en PKCS#8 : il ne reste qu'à y accoler la graine. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function loadSigningKey() {
    const seed = Buffer.from(env.ORDER_SIGNING_KEY, 'base64');
    if (seed.length !== 32) {
        throw new Error(
            'ORDER_SIGNING_KEY doit être une graine Ed25519 de 32 octets en base64 (openssl rand -base64 32).'
        );
    }
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

const privateKey = loadSigningKey();

/** La clé publique, 32 octets en base64 : ce que l'agent épingle à l'enrôlement. */
export const orderSigningPublicKey: string = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');

/**
 * La trame d'un ordre vers un agent, signée si l'ordre l'exige. Construite par
 * concaténation et non par `JSON.stringify` de l'ensemble : les octets du
 * payload sur le fil sont exactement ceux qui ont été signés, l'agent les relit
 * tels quels sans les re-sérialiser.
 */
export function agentFrame(command: string, payload: unknown, now: number = Date.now()): string {
    const payloadJson = JSON.stringify(payload);
    const head = `{"command":${JSON.stringify(command)},"payload":${payloadJson}`;
    if (!SIGNED_AGENT_COMMANDS.has(command)) return `${head}}`;
    const nonce = randomBytes(16).toString('hex');
    const message = Buffer.concat([Buffer.from(`${command}\n${nonce}\n${now}\n`), Buffer.from(payloadJson)]);
    const signature = sign(null, message, privateKey).toString('base64');
    return `${head},"sig":${JSON.stringify({ nonce, issuedAt: now, signature })}}`;
}
