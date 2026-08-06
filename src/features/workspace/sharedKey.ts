import { workspaceSharedKeyStatus, workspaceEnableSharedKey } from 'deveye-types';
import { DekCipher } from '@/Services/SecureStore';
import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * Conversion d'un espace partagé vers sa **propre** clé de données.
 *
 * Pourquoi une action explicite plutôt qu'une migration SQL : jusqu'ici un
 * espace partagé résout les clés de son propriétaire. Si celui-ci a activé le
 * chiffrement par mot de passe, son contenu n'est déchiffrable qu'avec ce mot de
 * passe — le serveur, seul, en est incapable. Aucune migration ne peut donc le
 * convertir ; il faut une session vivante et déverrouillée du propriétaire.
 *
 * Après conversion, la clé de l'espace est emballée par la clé serveur : tout
 * membre lit l'espace, et les tâches de fond y travaillent sans session.
 */

export const workspaceSharedKeyStatusFeature: FeatureDefinition<
    typeof workspaceSharedKeyStatus.command,
    typeof workspaceSharedKeyStatus.input,
    typeof workspaceSharedKeyStatus.output
> = defineFeature({
    ...workspaceSharedKeyStatus,
    handler: async (ctx) => {
        if (ctx.workspace.kind === 'personal') {
            return { enabled: false, applicable: false, blockers: [] };
        }
        const enabled = await ctx.secretKeys.hasWorkspaceDek(ctx.workspaceId);
        return {
            enabled,
            applicable: true,
            blockers: enabled ? [] : await ctx.db.workspaceRekey.blockers(ctx.workspaceId)
        };
    }
});

export const workspaceEnableSharedKeyFeature: FeatureDefinition<
    typeof workspaceEnableSharedKey.command,
    typeof workspaceEnableSharedKey.input,
    typeof workspaceEnableSharedKey.output
> = defineFeature({
    ...workspaceEnableSharedKey,
    mutates: true,
    handler: async (ctx) => {
        if (ctx.workspace.kind === 'personal') {
            throw new FeatureError('validation', 'L’espace personnel garde votre clé personnelle');
        }
        if (!ctx.isOwner) {
            throw new FeatureError('forbidden', 'Réservé au propriétaire de l’espace');
        }
        if (await ctx.secretKeys.hasWorkspaceDek(ctx.workspaceId)) {
            return { converted: 0 };
        }

        const blockers = await ctx.db.workspaceRekey.blockers(ctx.workspaceId);
        if (blockers.length > 0) {
            throw new FeatureError('conflict', blockers.join(' '));
        }

        // Tout lire AVANT de créer la nouvelle clé : `ctx.secure` résout encore
        // les clés du propriétaire tant qu'aucune clé d'espace n'existe, et
        // lèvera `locked` ici si la session ne l'est pas — donc avant d'avoir
        // touché quoi que ce soit.
        const cells = await ctx.db.workspaceRekey.readAll(ctx.workspaceId);
        const plaintexts: (string | null)[] = [];
        for (const cell of cells) {
            // Chaque colonne se relit sous l'étage qui l'a écrite : le coffre est
            // gardé, notes et uptime sont ouverts. Après conversion la distinction
            // disparaît — la clé d'espace sert les deux.
            const source = cell.tier === 'guarded' ? ctx.secure : ctx.secure.open;
            plaintexts.push(await source.tryDecrypt(cell.value));
        }

        // Un seul blob illisible et on renonce : convertir les autres laisserait
        // l'espace à moitié sous chaque clé, sans moyen de revenir en arrière.
        const unreadable = plaintexts.filter((p) => p === null).length;
        if (unreadable > 0) {
            throw new FeatureError(
                'conflict',
                `${unreadable} élément(s) de cet espace n’ont pas pu être déchiffrés. Conversion annulée : ` +
                    'aucune donnée n’a été modifiée.'
            );
        }

        // La clé n'est créée qu'ici, une fois tout le contenu en clair en mémoire.
        const dek = await ctx.secretKeys.resolveWorkspaceDek(ctx.workspaceId);
        const target = new DekCipher(() => Promise.resolve(dek));

        for (let i = 0; i < cells.length; i++) {
            await ctx.db.workspaceRekey.write({ ...cells[i], value: await target.encrypt(plaintexts[i]!) });
        }

        // Les connexions vivantes tiennent encore un coffre bâti sur les clés du
        // propriétaire : sans cette invalidation elles continueraient de lire avec
        // l'ancienne clé et ne déchiffreraient plus rien.
        invalidateAccess();

        ctx.audit({
            action: 'workspace.enableSharedKey',
            level: 'warning',
            description: `Clé d’espace activée pour « ${ctx.workspace.name} » (${cells.length} élément(s) reconvertis)`,
            metadata: { converted: cells.length }
        });

        return { converted: cells.length };
    }
});
