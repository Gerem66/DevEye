import { SegmentedControl } from 'deveye-sdk-client';

import type { AudienceRange } from '../contracts/domain';

import { RANGE_LABELS, RANGES } from './format';

interface RangeBarProps {
    value: AudienceRange;
    onChange: (range: AudienceRange) => void;
}

/**
 * Les fenêtres offertes, du plus près au plus loin. Chaque bloc qui mesure
 * quelque chose porte la sienne : deux blocs d'un même écran ne répondent pas
 * forcément à la même question.
 */
export function RangeBar({ value, onChange }: RangeBarProps) {
    return (
        <SegmentedControl
            value={value}
            options={RANGES.map((range) => ({ value: range, label: RANGE_LABELS[range] }))}
            onChange={onChange}
            aria-label='Période'
        />
    );
}

export default RangeBar;
