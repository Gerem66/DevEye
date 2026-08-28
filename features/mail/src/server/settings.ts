import { mailGetSettings, mailSetSettings } from '../contracts/commands';
import { defineSdkFeature } from '@deveye/types/sdk/server';

import type { MailRepo } from './repo';
import { toSettingsDTO, WRITE } from './_shared';

/**
 * Les réglages de l'espace (l'onglet Général de la feature) : l'analyse
 * externe, les domaines d'images approuvés, le mode de rendu des corps. Des
 * colonnes en clair (`mail_settings`) : des hôtes et des drapeaux, pas des
 * secrets.
 */

export const mailGetSettingsFeature = defineSdkFeature<
    MailRepo,
    typeof mailGetSettings.command,
    typeof mailGetSettings.input,
    typeof mailGetSettings.output
>({
    ...mailGetSettings,
    handler: async (ctx) => {
        const row = await ctx.repo.settings.get(ctx.workspaceId);
        return { settings: toSettingsDTO(row) };
    }
});

export const mailSetSettingsFeature = defineSdkFeature<
    MailRepo,
    typeof mailSetSettings.command,
    typeof mailSetSettings.input,
    typeof mailSetSettings.output
>({
    ...mailSetSettings,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await ctx.repo.settings.set(ctx.workspaceId, {
            externalScanEnabledDefault: input.externalScanEnabledDefault,
            trustedImageDomains: input.trustedImageDomains,
            bodyRenderMode: input.bodyRenderMode
        });
        ctx.audit({
            action: 'mail.setSettings',
            description: 'Paramètres Mail modifiés',
            metadata: { externalScan: input.externalScanEnabledDefault, bodyRenderMode: input.bodyRenderMode }
        });
        return { settings: toSettingsDTO(row) };
    }
});
