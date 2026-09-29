import { z } from 'zod';

/**
 * Ce que DevEye répond à sa page d'état (`statuspage/`), qui tourne dans un
 * autre conteneur. Privé au dépôt : l'image de la page ne dépend d'aucune
 * publication de `@deveye/types`. Rien d'autre que zod ici, la page l'embarque.
 */

export const STATUS_PROBE_PATH = '/api/statuspage/probe';
export const STATUS_CHANNELS_PATH = '/api/statuspage/channels';

/** `maintenance` compte comme une indisponibilité : la page d'état le dit ainsi. */
export const featureStateSchema = z.enum(['up', 'degraded', 'down', 'maintenance']);
export type FeatureState = z.infer<typeof featureStateSchema>;

export const statusProbeSchema = z.object({
    version: z.string(),
    /** La base répond-elle ? Sans elle, plus rien ne marche. */
    database: z.boolean(),
    site: z.object({
        /** `degraded` : la priorité aux abonnés est donnée, les autres comptes sont tenus. */
        state: z.enum(['up', 'degraded', 'maintenance']),
        /** Le message public de la maintenance, `null` hors maintenance. */
        message: z.string().nullable()
    }),
    /** Les modules installés, hors préversion. Leur état propre : celui du site s'y ajoute côté page. */
    features: z.array(
        z.object({
            id: z.string(),
            label: z.string(),
            state: featureStateSchema,
            reason: z.string().nullable()
        })
    )
});
export type StatusProbe = z.infer<typeof statusProbeSchema>;

/** Les destinations des alertes Système, pour que la page d'état prévienne quand DevEye ne le peut plus. */
export const statusChannelsSchema = z.object({
    webhooks: z.array(z.object({ kind: z.enum(['webhook', 'discord']), url: z.string() })),
    emails: z.array(z.string())
});
export type StatusChannels = z.infer<typeof statusChannelsSchema>;
