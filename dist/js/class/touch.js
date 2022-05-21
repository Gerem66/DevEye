/**
 * @typedef {Object} MyTouchEvent
 * @property {number} absoluteX Position of the touch on the screen
 * @property {number} absoluteY Position of the touch on the screen
 * @property {Number} relativeX Distance from start point
 * @property {Number} relativeY Distance from start point
 * 
 * @callback TouchStart
 * @param {MyTouchEvent} event
 * @returns {Boolean} Prevent default
 * 
 * @callback TouchMove
 * @param {MyTouchEvent} event
 * @returns {Boolean} Prevent default
 * 
 * @callback TouchEnd
 * @param {MyTouchEvent} event
 * @returns {Boolean} Prevent default
 * 
 * @callback Press
 * @param {MyTouchEvent} event
 * 
 * @callback LongPress
 * @param {MyTouchEvent} event
 * 
 * @typedef {Object} TouchCallbacks
 * @property {TouchStart} TouchStart
 * @property {TouchMove} TouchMove
 * @property {TouchEnd} TouchEnd
 * @property {Press} Press
 * @property {LongPress} LongPress
 */

class MyTouch {
    /**
     * Define events for an element and add event listeners for both mouse and touch
     * @param {HTMLElement} element Default: document.body
     */
    constructor(element) {
        this.timer = 0;
        this.move = false;
        this.mouseMove = false;
        this.cursor = { x: 0, y: 0 };
        this.delta = { x: 0, y: 0 };
        this.exceed = { x: false, y: false };

        /** @type {TouchCallbacks} */
        this.events = {};

        if (typeof(element) !== 'object') element = document.body;
        element.addEventListener('touchstart', this.scrollMoveStart.bind(this));
        element.addEventListener('mousedown', this.scrollMoveStart.bind(this));
        element.addEventListener('touchmove', this.scrollMove.bind(this));
        element.addEventListener('mousemove', this.scrollMove.bind(this));
        element.addEventListener('touchend', this.scrollMoveEnd.bind(this));
        element.addEventListener('mouseup', this.scrollMoveEnd.bind(this));
    }

    /**
     * @typedef {keyof TouchCallbacks} E
     * @param {E} event
     * @param {TouchCallbacks[E]} callback
     */
    AddEventListener(event, callback) {
        if (typeof(callback) !== 'function') {
            throw new Error('Callback is not a function');
        }
        this.events[event] = callback;
    }

    /**
     * @param {keyof TouchCallbacks} event
     */
    RemoveEventListener(event) {
        if (this.events.hasOwnProperty(event)) {
            this.events[event] = null;
            delete this.events[event];
        }
    }

    /**
     * @param {keyof TouchCallbacks} event
     * @returns {Boolean} True if event exists and is a function
     */
    checkEventName(event) {
        return this.events.hasOwnProperty(event) && typeof(this.events[event]) === 'function';
    }

    /** @param {TouchEvent} e */
    scrollMoveStart(e) {
        this.delta = { x: 0, y: 0 };
        this.exceed = { x: false, y: false };

        this.move = true;
        this.timer = Date.now();
        if (typeof(e.touches) !== 'undefined') {
            // Touch
            this.cursor.x = e.touches[0].clientX;
            this.cursor.y = e.touches[0].clientY;
        } else {
            // Mouse
            this.mouseMove = true;
            this.cursor.x = e.clientX;
            this.cursor.y = e.clientY;
        }

        if (this.checkEventName('TouchStart')) {
            const myEvent = {
                absoluteX: e.pageX,
                absoluteY: e.pageY,
                relativeX: this.delta.x,
                relativeY: this.delta.y
            };
            const prevent = this.events['TouchStart'](myEvent);
            if (prevent) e.preventDefault();
        }
    }
    /** @param {TouchEvent} e */
    scrollMove(e) {
        if (!this.move) return;

        if (typeof(e.touches) !== 'undefined') {
            this.delta.x = this.cursor.x - e.touches[0].clientX;
            this.delta.y = this.cursor.y - e.touches[0].clientY;
        } if (this.mouseMove) {
            this.delta.x = this.cursor.x - e.clientX;
            this.delta.y = this.cursor.y - e.clientY;
        }
        if (Math.abs(this.delta.x) > 20) this.exceed.x = true;
        if (Math.abs(this.delta.y) > 20) this.exceed.y = true;

        if (this.checkEventName('TouchMove')) {
            const myEvent = {
                absoluteX: e.pageX,
                absoluteY: e.pageY,
                relativeX: this.delta.x,
                relativeY: this.delta.y
            };
            const prevent = this.events['TouchMove'](myEvent);
            if (prevent) e.preventDefault();
        }
    }
    /** @param {TouchEvent} e */
    scrollMoveEnd(e) {
        const myEvent = {
            absoluteX: e.pageX,
            absoluteY: e.pageY,
            relativeX: this.delta.x,
            relativeY: this.delta.y
        };
        const smallMove = Math.abs(this.delta.x) < 5 && Math.abs(this.delta.y) < 5;
        const notExceed = !this.exceed.x && !this.exceed.y;
        const longTime = Date.now() - this.timer > 400;

        if (notExceed && smallMove) {
            if (!longTime && this.checkEventName('Press')) this.events['Press'](myEvent);
            if (longTime && this.checkEventName('LongPress')) this.events['LongPress'](myEvent);
        }

        if (this.checkEventName('TouchEnd')) {
            const prevent = this.events['TouchEnd'](myEvent);
            if (prevent) e.preventDefault();
        }

        if (this.move) this.move = false;
        if (this.mouseMove) this.mouseMove = false;
    }
}