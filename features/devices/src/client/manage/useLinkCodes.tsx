import { useEffect, useState } from 'react';
import { copyText, onResourceChange, openInfo } from 'deveye-sdk-client';
import type { LinkCodeResponse, LinkCodesListResponse } from '@deveye/types';

import { api } from '../api';
import { LinkInfo } from './LinkInfo';

/** Les durées proposées à l'émission, en secondes. */
export const TTL_PRESETS = [
    { value: '900', label: '15 min' },
    { value: '3600', label: '1 h' },
    { value: '86400', label: '1 jour' },
    { value: '604800', label: '7 jours' }
] as const;

export type TtlPreset = (typeof TTL_PRESETS)[number]['value'];

/**
 * Link-code management for the pairing dialog: list the workspace's active
 * codes with the server they enroll on and the plan's room, generate new ones
 * (validity, number of machines), pick the one the install command uses,
 * revoke, copy.
 */
export function useLinkCodes(refresh: () => Promise<void> | void) {
    const [codes, setCodes] = useState<LinkCodeResponse[]>([]);
    const [server, setServer] = useState<string | null>(null);
    const [quota, setQuota] = useState<LinkCodesListResponse['quota']>(null);
    /** La liste n'a pas pu être relue : à dire, plutôt que d'afficher « aucun code ». */
    const [codesError, setCodesError] = useState<string | null>(null);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [generatingCode, setGeneratingCode] = useState(false);
    const [genError, setGenError] = useState<string | null>(null);
    const [copiedCode, setCopiedCode] = useState<string | null>(null);
    const [ttlPreset, setTtlPreset] = useState<TtlPreset>('900');
    /** `null` : le champ est vide le temps d'une saisie. */
    const [maxUses, setMaxUses] = useState<number | null>(1);
    const [selectedCode, setSelectedCode] = useState<string | null>(null);

    const fetchCodes = async (): Promise<LinkCodeResponse[]> => {
        try {
            const res = await api.send('devices.linkCodeList', {});
            setCodes(res.codes);
            setServer(res.server);
            setQuota(res.quota);
            setCodesError(null);
            return res.codes;
        } catch (e) {
            // Ne PAS retomber sur une liste vide en silence : « Aucun code
            // actif » se lit comme une certitude, et un code encore valide peut
            // circuler.
            setCodesError(e instanceof Error ? e.message : 'Codes actifs indisponibles.');
            return [];
        }
    };

    const generateLinkCode = async () => {
        setGeneratingCode(true);
        setGenError(null);
        try {
            const created = await api.send('devices.linkCodeCreate', {
                ttlSeconds: Number(ttlPreset),
                maxUses: maxUses ?? 1
            });
            // La commande affichée suit le code qu'on vient de demander.
            setSelectedCode(created.code);
            await fetchCodes();
        } catch {
            setGenError('Impossible de générer un code de liaison. Réessayez.');
        } finally {
            setGeneratingCode(false);
        }
    };

    const deleteCode = async (code: string) => {
        // Optimistic: drop it locally, reconcile via fetch on failure.
        setCodes((prev) => prev.filter((c) => c.code !== code));
        try {
            await api.send('devices.linkCodeRevoke', { code });
        } catch {
            await fetchCodes();
        }
    };

    // Open the dialog and show the current codes table.
    const openLinkModal = async () => {
        setGenError(null);
        setCopiedCode(null);
        setShowLinkModal(true);
        await fetchCodes();
    };

    const closeModal = () => {
        setShowLinkModal(false);
        // A device may have paired while the dialog was open.
        void refresh();
    };

    const copyCode = async (code: string) => {
        if (!(await copyText(code))) return;
        setCopiedCode(code);
        setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1800);
    };

    const showLinkInfo = () => void openInfo({ title: 'Lier un appareil', body: <LinkInfo />, width: 480 });

    // Dialogue ouvert, un code dont un appareil vient de prendre un usage doit
    // se mettre à jour : la route d'enrôlement signale le changement.
    useEffect(() => {
        if (!showLinkModal) return;
        return onResourceChange('devices.list', () => void fetchCodes());
    }, [showLinkModal]);

    /** Le code de la commande : celui qu'on a choisi s'il sert encore, sinon le premier. */
    const selected = codes.find((c) => c.code === selectedCode) ?? codes[0] ?? null;

    return {
        codes,
        server,
        quota,
        codesError,
        showLinkModal,
        generatingCode,
        genError,
        copiedCode,
        ttlPreset,
        setTtlPreset,
        maxUses,
        setMaxUses,
        selected,
        setSelectedCode,
        generateLinkCode,
        deleteCode,
        openLinkModal,
        closeModal,
        copyCode,
        showLinkInfo
    };
}

export type LinkCodes = ReturnType<typeof useLinkCodes>;
