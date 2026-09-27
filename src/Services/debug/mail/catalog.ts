import type { MailAttachment } from '@deveye/types/sdk';
import type { SdkMailSample, SdkMailSampleContext } from '@deveye/types/sdk/server';

import { moduleMailSamples } from '@/features/_sdk/register';
import { renderAccountMail } from '@/Services/mailLayout';
import { CORE_MAIL_SAMPLES } from './coreSamples';

export type CatalogEntry = SdkMailSample & {
    /** `<source>.<clé>` : `core.signupVerification`, `x-billing.renewal`. */
    fullKey: string;
    sourceLabel: string;
};

export interface RenderedMail {
    subject: string;
    text: string;
    html: string | null;
    attachments: MailAttachment[];
}

/** Tous les mails que ce serveur sait envoyer : le socle d'abord, puis les modules installés. */
export function mailCatalog(): CatalogEntry[] {
    const core = CORE_MAIL_SAMPLES.map((s) => ({ ...s, fullKey: `core.${s.key}`, sourceLabel: 'DevEye' }));
    const modules = moduleMailSamples().flatMap(({ featureId, label, samples }) =>
        samples.map((s) => ({ ...s, fullKey: `${featureId}.${s.key}`, sourceLabel: label }))
    );
    return [...core, ...modules];
}

/** Le mail tel qu'il partirait : un mail du serveur passe par la même mise en page que `accountMail.send`. */
export async function renderSample(entry: SdkMailSample, ctx: SdkMailSampleContext): Promise<RenderedMail> {
    if (entry.sender === 'server') {
        return { ...renderAccountMail(await entry.build(ctx)), attachments: [] };
    }
    const mail = await entry.build(ctx);
    return {
        subject: mail.subject,
        text: mail.text,
        html: mail.html ?? null,
        attachments: [...(mail.attachments ?? [])]
    };
}
