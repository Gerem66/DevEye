// Un mail ne lit aucune feuille de style : les teintes du thème sont recopiées
// ici, et nulle part ailleurs côté serveur.
const ACCENT = '#22d3ee';
const ACCENT_TINT = '#ecfeff';
const ON_ACCENT = '#05222a';
const TEXT = '#1b2430';
const MUTED = '#5b6672';

/** Le contenu d'un mail, en texte brut : la mise en page l'échappe. */
export interface MailContent {
    paragraphs: readonly string[];
    /** Encadré, après les paragraphes : ce que le lecteur ne doit pas manquer. */
    notice?: string;
    button?: { label: string; url: string };
    footnote?: string;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mailHtml({ paragraphs, notice, button, footnote }: MailContent): string {
    const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
    const box = notice
        ? `<p style="margin:8px 0 16px;padding:14px 16px;border:2px solid ${ACCENT};border-radius:8px;background:${ACCENT_TINT};font-weight:600">${escapeHtml(notice)}</p>`
        : '';
    const link = button
        ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${ACCENT};color:${ON_ACCENT};font-weight:600;text-decoration:none">${escapeHtml(button.label)}</a></p>`
        : '';
    const small = footnote ? `<p style="margin:0;font-size:13px;color:${MUTED}">${escapeHtml(footnote)}</p>` : '';
    return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5;color:${TEXT};max-width:480px;margin:0 auto;padding:24px">
<p style="margin:0 0 24px;font-size:20px"><b>Dev</b>Eye</p>
${body}${box}
${link}
${small}
</div>`;
}

/** La version texte du même contenu : l'encadré entre deux filets, le bouton en lien nu. */
export function mailText({ paragraphs, notice, button, footnote }: MailContent): string {
    return [
        ...paragraphs,
        ...(notice ? [`----------\n${notice}\n----------`] : []),
        ...(button ? [`${button.label} : ${button.url}`] : []),
        ...(footnote ? [footnote] : [])
    ].join('\n\n');
}
