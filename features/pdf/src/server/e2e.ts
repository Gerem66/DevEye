import type { FeatureE2eEntry } from '@deveye/types/sdk/server';

import type { SavedSignature } from '../contracts/signatures';
import type { PdfRepo } from './repo';

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const PATH = 'M 0 10 L 40 0 L 80 20';

/** Une signature gardée sur le compte : enregistrée, relue déchiffrée, scellée au repos, retirée. */
export const pdfE2e: FeatureE2eEntry<PdfRepo> = {
    scenarios: [
        {
            id: 'savedSignature',
            label: 'Une signature gardée, de l’enregistrement au retrait',
            steps: [
                {
                    label: 'Garder une signature dessinée',
                    run: async (ctx) => {
                        const { signature } = await ctx.send<{ signature: SavedSignature }>('pdf.signatureSave', {
                            role: 'signature',
                            data: { kind: 'path', path: PATH, width: 80, height: 20, stroke: 2.5 }
                        });
                        ctx.state.set('signatureId', signature.id);
                        ctx.defer('Retirer la signature', async () => {
                            await ctx.send('pdf.signatureRemove', { id: signature.id });
                        });
                        return `Signature ${signature.id}`;
                    }
                },
                {
                    label: 'La relire déchiffrée',
                    run: async (ctx) => {
                        const { signatures } = await ctx.send<{ signatures: SavedSignature[] }>('pdf.signatures', {});
                        const mine = signatures.find((s) => s.id === ctx.state.get('signatureId'));
                        check(mine, 'La signature gardée ne revient pas dans la liste');
                        check(
                            mine.data.kind === 'path' && mine.data.path === PATH,
                            'Le tracé relu n’est pas celui gardé'
                        );
                    }
                },
                {
                    label: 'Vérifier qu’elle est scellée au repos',
                    run: async (ctx) => {
                        const rows = await ctx.repo.signatures(ctx.account.userId);
                        const row = rows.find((r) => r.id === ctx.state.get('signatureId'));
                        check(row, 'La signature est introuvable en base');
                        check(!row.data_enc.includes(PATH), 'Le tracé est lisible en clair en base');
                    }
                },
                {
                    label: 'La retirer',
                    run: async (ctx) => {
                        const { removed } = await ctx.send<{ removed: boolean }>('pdf.signatureRemove', {
                            id: ctx.state.get('signatureId')
                        });
                        check(removed, 'Le retrait n’a rien retiré');
                        const { signatures } = await ctx.send<{ signatures: SavedSignature[] }>('pdf.signatures', {});
                        check(
                            !signatures.some((s) => s.id === ctx.state.get('signatureId')),
                            'La signature retirée est encore listée'
                        );
                    }
                }
            ]
        }
    ]
};
