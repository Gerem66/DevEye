/** L'emoji d'un code météo WMO, pour la fiche, la tuile et la barre du haut. */
const WMO_ICONS: Record<number, string> = {
    0: '☀️',
    1: '🌤️',
    2: '⛅',
    3: '☁️',
    45: '🌫️',
    48: '🌫️',
    51: '🌦️',
    53: '🌦️',
    55: '🌧️',
    61: '🌧️',
    63: '🌧️',
    65: '🌧️',
    71: '🌨️',
    73: '🌨️',
    75: '❄️',
    80: '🌦️',
    81: '🌧️',
    82: '🌧️',
    95: '⛈️',
    96: '⛈️',
    99: '⛈️'
};

export function wmoIcon(code: number): string {
    return WMO_ICONS[code] ?? '🌡️';
}
