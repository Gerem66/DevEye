import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { invoicingConfigGet, invoicingConfigSave } from '../../contracts/commands';
import { invoicingSettingsSchema } from '../../contracts/domain';
import { monthUsage } from '../planUsage';
import { now, seal, settingsOf, settingsRow, today, WRITE, type Ctx } from '../_shared';

export const settingsGet = defineSdkFeature({
    ...invoicingConfigGet,
    handler: async (ctx: Ctx) => {
        const settings = await settingsOf(ctx);
        const usage = await monthUsage(ctx.quota, ctx.repo, today(settings));
        return { settings, usage };
    }
});

/**
 * L'identité de l'émetteur porte l'IBAN qui figure sur chaque facture : la
 * changer est la cible d'une fraude classique, d'où le droit propre. Le reste
 * des réglages passerait bien avec la seule écriture, mais les séparer en deux
 * commandes ferait deux portes pour un seul formulaire.
 */
export const settingsSave = defineSdkFeature({
    ...invoicingConfigSave,
    access: { ...WRITE, extras: ['issuer'] },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const settings = invoicingSettingsSchema.parse(input.settings);
        if (settings.vatRegime === 'exempt' && settings.defaultVatBp !== 0) {
            // Le régime et le taux par défaut se contrediraient dès la première
            // ligne : le commutateur de TVA décide, et il décide seul.
            throw new FeatureError(
                'validation',
                'En franchise de TVA, le taux par défaut d’une ligne ne peut pas être autre que zéro.'
            );
        }

        // Un domaine retiré entre l'ouverture du formulaire et son envoi ne doit
        // pas revenir désigner une ligne disparue.
        if (settings.domainId !== null && (await ctx.domains.get(settings.domainId)) === null) {
            throw new FeatureError('validation', 'Ce domaine n’existe plus : choisissez-en un autre.');
        }

        const content = await seal(ctx, { issuer: settings.issuer, wording: settings.wording });
        await ctx.repo.saveSettings(ctx.workspaceId, settingsRow(settings, content), now());
        ctx.audit({
            action: 'invoicing.config',
            description: 'Réglages de facturation enregistrés'
        });
        return { settings };
    }
});

export const settingsHandlers = [settingsGet, settingsSave];
