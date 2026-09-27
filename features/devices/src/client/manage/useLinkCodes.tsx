import { useEffect, useState } from 'react';
import { copyText, onResourceChange, openInfo } from 'deveye-sdk-client';
import type { LinkCodeResponse } from '@deveye/types';

import { api } from '../api';
import { LinkInfo } from './LinkInfo';

/**
 * Link-code management for the "Ajouter un appareil" dialog: list the
 * workspace's active codes, generate new ones (validity preset), revoke, copy.
 */
export function useLinkCodes(refresh: () => Promise<void> | void) {
    const [codes, setCodes] = useState<LinkCodeResponse[]>([]);
    /** La liste n'a pas pu être relue : à dire, plutôt que d'afficher « aucun code ». */
    const [codesError, setCodesError] = useState<string | null>(null);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [generatingCode, setGeneratingCode] = useState(false);
    const [genError, setGenError] = useState<string | null>(null);
    const [copiedCode, setCopiedCode] = useState<string | null>(null);
    // Validity preset for newly generated codes, in seconds.
    const [ttlPreset, setTtlPreset] = useState<string>('300');

    const fetchCodes = async (): Promise<LinkCodeResponse[]> => {
        try {
            const res = await api.send('devices.linkCodeList', {});
            setCodes(res.codes);
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
            await api.send('devices.linkCodeCreate', { ttlSeconds: Number(ttlPreset) });
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

    const showLinkInfo = () => void openInfo({ title: 'Lier un appareil', body: <LinkInfo />, width: 460 });

    // Dialogue ouvert, un code consommé par un appareil qui s'appaire doit
    // disparaître du tableau : la route d'enrôlement signale le changement.
    useEffect(() => {
        if (!showLinkModal) return;
        return onResourceChange('devices.list', () => void fetchCodes());
    }, [showLinkModal]);

    return {
        codes,
        codesError,
        showLinkModal,
        generatingCode,
        genError,
        copiedCode,
        ttlPreset,
        setTtlPreset,
        generateLinkCode,
        deleteCode,
        openLinkModal,
        closeModal,
        copyCode,
        showLinkInfo
    };
}

export type LinkCodes = ReturnType<typeof useLinkCodes>;
