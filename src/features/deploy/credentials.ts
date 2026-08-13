import {
    deployCredentialAdd,
    deployCredentialList,
    deployCredentialRemove,
    deployCredentialUpdate
} from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';
import { addCredential, listCredentials, removeCredential, updateCredential } from '../_credentials';
import { READ, WRITE } from './_shared';

/**
 * Les clés d'API **Dokploy** de l'espace.
 *
 * Elles vivaient dans la feature Git, où elles n'avaient jamais eu de raison
 * d'être : un jeton git et une clé de mise en production ne se ressemblent que
 * par leur forme. Elles y étaient parce que le déploiement n'était alors qu'un
 * onglet de projet, sans écran à lui pour les accueillir — la feature ayant
 * désormais le sien, poser la clé qui déploie relève de `deploy`, pas de `git`.
 *
 * Le comportement est dans `_credentials.ts`, partagé avec l'autre porte : seuls
 * le fournisseur et le droit exigé changent. Ici l'adresse de l'instance est
 * **obligatoire** — Dokploy est auto-hébergé, sans elle rien n'est adressable.
 */

export const deployCredentialListFeature: FeatureDefinition<
    typeof deployCredentialList.command,
    typeof deployCredentialList.input,
    typeof deployCredentialList.output
> = defineFeature({
    ...deployCredentialList,
    access: READ,
    handler: async (ctx) => ({ credentials: await listCredentials(ctx, 'dokploy') })
});

export const deployCredentialAddFeature: FeatureDefinition<
    typeof deployCredentialAdd.command,
    typeof deployCredentialAdd.input,
    typeof deployCredentialAdd.output
> = defineFeature({
    ...deployCredentialAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => ({
        credential: await addCredential(ctx, 'dokploy', {
            label: input.label,
            baseUrl: input.baseUrl,
            secret: input.secret
        })
    })
});

export const deployCredentialUpdateFeature: FeatureDefinition<
    typeof deployCredentialUpdate.command,
    typeof deployCredentialUpdate.input,
    typeof deployCredentialUpdate.output
> = defineFeature({
    ...deployCredentialUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => ({
        credential: await updateCredential(ctx, 'dokploy', {
            credentialId: input.credentialId,
            label: input.label,
            baseUrl: input.baseUrl,
            secret: input.secret
        })
    })
});

export const deployCredentialRemoveFeature: FeatureDefinition<
    typeof deployCredentialRemove.command,
    typeof deployCredentialRemove.input,
    typeof deployCredentialRemove.output
> = defineFeature({
    ...deployCredentialRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await removeCredential(ctx, 'dokploy', input.credentialId);
        return { credentialId: input.credentialId };
    }
});

export const deployCredentialFeatures = [
    deployCredentialListFeature,
    deployCredentialAddFeature,
    deployCredentialUpdateFeature,
    deployCredentialRemoveFeature
];
