/** `g•••@gmail.com` : assez pour reconnaître son adresse, pas pour l'apprendre. */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf('@');
    if (at < 1) return '•••';
    return `${email[0]}•••${email.slice(at)}`;
}
