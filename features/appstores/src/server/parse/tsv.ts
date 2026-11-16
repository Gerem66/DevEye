import type { Table } from './csv';

/**
 * Un tableau séparé par des tabulations, la forme des rapports de ventes
 * d'Apple : sans guillemets ni échappement, une ligne par enregistrement.
 */
export function parseTsv(text: string): Table {
    const lines = text
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '');
    const [head = '', ...rest] = lines;
    return { header: head.split('\t').map((name) => name.trim()), rows: rest.map((line) => line.split('\t')) };
}
