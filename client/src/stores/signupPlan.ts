/**
 * L'indice `plan` donné à l'inscription (`/signup?plan=…`), rendu par le serveur
 * à la création du compte. Lu une fois par l'accueil, puis oublié.
 */
let pending: string | null = null;

export function setSignupPlan(plan: string | null): void {
    pending = plan;
}

export function takeSignupPlan(): string | null {
    const plan = pending;
    pending = null;
    return plan;
}
