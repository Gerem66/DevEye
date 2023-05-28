import CardElement from './card';
import CardValue from './value';

/**
 * @typedef {'1'|'1/2'|'1/3'|'2/3'|'1/4'|'3/4'|'1/5'|'2/5'|'3/5'|'4/5'|'1/6'|'5/6'} CardSize
 */

const Card = {
    Element: CardElement,
    Value: CardValue
}

export default Card;