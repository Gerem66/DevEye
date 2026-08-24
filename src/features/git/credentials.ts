import { gitCredentialAdd, gitCredentialList, gitCredentialRemove, gitCredentialUpdate } from '@deveye/types';
import { defineFeature, type FeatureDefinition } from '../_define';
import { addCredential, listCredentials, removeCredential, updateCredential } from '../_credentials';
import { READ, WRITE } from './_shared';

/**
 * Les jetons **GitHub** de l'espace.
 *
 * Ils vivent ici et non dans un projet : un même jeton ouvre en général
 * plusieurs dépôts, et le ressaisir par projet serait à la fois pénible et plus
 * risqué.
 *
 * Les clés **Dokploy** ont quitté cet écran : elles appartiennent à la feature
 * Déploiement (`features/deploy/credentials.ts`). Elles n'avaient atterri ici
 * que parce que ce module fut le premier à savoir gérer un secret, à une époque
 * où le déploiement n'était qu'un onglet de projet sans place pour le sien.
 *
 * Le comportement est dans `_credentials.ts`, partagé avec l'autre porte : seuls
 * le fournisseur et le droit exigé changent. Aucun `baseUrl` ici — l'API GitHub
 * est publique, il n'y a pas d'instance à désigner.
 */

export const gitCredentialListFeature: FeatureDefinition<
    typeof gitCredentialList.command,
    typeof gitCredentialList.input,
    typeof gitCredentialList.output
> = defineFeature({
    ...gitCredentialList,
    access: READ,
    handler: async (ctx) => ({ credentials: await listCredentials(ctx, 'github') })
});

export const gitCredentialAddFeature: FeatureDefinition<
    typeof gitCredentialAdd.command,
    typeof gitCredentialAdd.input,
    typeof gitCredentialAdd.output
> = defineFeature({
    ...gitCredentialAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => ({
        credential: await addCredential(ctx, 'github', { label: input.label, baseUrl: null, secret: input.secret })
    })
});

export const gitCredentialUpdateFeature: FeatureDefinition<
    typeof gitCredentialUpdate.command,
    typeof gitCredentialUpdate.input,
    typeof gitCredentialUpdate.output
> = defineFeature({
    ...gitCredentialUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => ({
        credential: await updateCredential(ctx, 'github', {
            credentialId: input.credentialId,
            label: input.label,
            baseUrl: null,
            secret: input.secret
        })
    })
});

export const gitCredentialRemoveFeature: FeatureDefinition<
    typeof gitCredentialRemove.command,
    typeof gitCredentialRemove.input,
    typeof gitCredentialRemove.output
> = defineFeature({
    ...gitCredentialRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await removeCredential(ctx, 'github', input.credentialId);
        return { credentialId: input.credentialId };
    }
});

export const gitCredentialFeatures = [
    gitCredentialListFeature,
    gitCredentialAddFeature,
    gitCredentialUpdateFeature,
    gitCredentialRemoveFeature
];
