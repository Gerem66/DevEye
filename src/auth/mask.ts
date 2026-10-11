/** `•• •• •• 56 78` : les quatre derniers chiffres, comme on lit un numéro en France. */
export function maskPhone(e164: string): string {
    const digits = e164.replace(/\D/g, '');
    const last = digits.slice(-4);
    return `•• •• •• ${last.slice(0, 2)} ${last.slice(2)}`;
}

/** `g•••@gmail.com` : assez pour reconnaître son adresse, pas pour l'apprendre. */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf('@');
    if (at < 1) return '•••';
    return `${email[0]}•••${email.slice(at)}`;
}
