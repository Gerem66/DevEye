import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { pdfPrefs, pdfPrefsSet, pdfSignatureRemove, pdfSignatures, pdfSignatureSave } from '../contracts/commands';
import { DEFAULT_PREFS, prefsSchema } from '../contracts/prefs';
import { SIGNATURES_MAX, storedSignatureSchema, type SavedSignature } from '../contracts/signatures';
import type { PdfRepo } from './repo';

type Ctx = SdkFeatureContext<PdfRepo>;

/** Les commandes du compte : l'espace est le personnel, quoi que le client ait envoyé. */
const ACCOUNT = { scope: 'account' } as const;

const now = (): number => Math.floor(Date.now() / 1000);

/** La clé des réglages dans le magasin de l'espace personnel. */
const PREFS_KEY = 'prefs';

/** Les signatures lisibles d'un compte ; une ligne qui ne se déchiffre plus (clé changée) est passée. */
async function savedSignatures(ctx: Ctx): Promise<SavedSignature[]> {
    const cipher = ctx.cipher();
    const out: SavedSignature[] = [];
    for (const row of await ctx.repo.signatures(ctx.userId)) {
        const plain = await cipher.tryDecrypt(row.data_enc);
        if (plain === null) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(plain);
        } catch {
            continue;
        }
        const data = storedSignatureSchema.safeParse(parsed);
        if (!data.success) continue;
        out.push({ id: row.id, role: row.role, data: data.data, createdAt: Number(row.created) });
    }
    return out;
}

export const pdfHandlers = [
    defineSdkFeature({
        ...pdfSignatures,
        access: ACCOUNT,
        handler: async (ctx: Ctx) => ({ signatures: await savedSignatures(ctx) })
    }),
    defineSdkFeature({
        ...pdfSignatureSave,
        access: ACCOUNT,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            if ((await ctx.repo.countSignatures(ctx.userId)) >= SIGNATURES_MAX) {
                throw new FeatureError(
                    'conflict',
                    `Vous gardez déjà ${SIGNATURES_MAX} signatures : retirez-en une pour en garder une nouvelle.`
                );
            }
            const at = now();
            const id = await ctx.repo.insertSignature({
                workspaceId: ctx.workspaceId,
                userId: ctx.userId,
                role: input.role,
                dataEnc: await ctx.cipher().encrypt(JSON.stringify(input.data)),
                at
            });
            return { signature: { id, role: input.role, data: input.data, createdAt: at } };
        }
    }),
    defineSdkFeature({
        ...pdfSignatureRemove,
        access: ACCOUNT,
        mutates: true,
        handler: async (ctx: Ctx, input) => ({ removed: await ctx.repo.removeSignature(input.id, ctx.userId) })
    }),
    defineSdkFeature({
        ...pdfPrefs,
        access: ACCOUNT,
        handler: async (ctx: Ctx) => ({ prefs: (await ctx.store.getJson(PREFS_KEY, prefsSchema)) ?? DEFAULT_PREFS })
    }),
    defineSdkFeature({
        ...pdfPrefsSet,
        access: ACCOUNT,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ctx.store.putJson(PREFS_KEY, prefsSchema, input.prefs);
            return { prefs: input.prefs };
        }
    })
];
