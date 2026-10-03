/** Minuscules et sans accents : « etats » trouve « États-Unis ». */
export function foldText(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
