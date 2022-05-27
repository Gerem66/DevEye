/**
 * @typedef {Object} ToolbarProps
 * @property {string} name The name returned in events
 * @property {string} title The title of the toolbar
 * @property {string} icon The icon of the toolbar
 * 
 * @callback onPropClickToolbar
 * @param {string} name The name of the toolbar
 */

class Toolbar {
    /**
     * @param {HTMLElement} parent
     * @param {{x: Number, y: Number}} position
     * @param {Array<ToolbarProps>} props
     * @param {onPropClickToolbar} callback
     */
    constructor(parent, position, props, callback) {
        this.element = document.createElement('div');
        this.element.classList.add('toolbar');
        this.element.style.top = position.y + 'px';
        this.element.style.left = position.x + 'px';
        this.element.onmouseleave = () => this.Remove();

        props.forEach(prop => {
            const a = document.createElement('a');
            a.innerHTML = `<i class="icon icon-${prop.icon}"></i>`;
            a.title = prop.title;
            a.onclick = () => {
                callback(prop.name);
                this.Remove();
            };
            this.element.appendChild(a);
        });

        parent.append(this.element);
        setTimeout(() => this.element.classList.add('active'), 100);
    }

    Remove() {
        this.element.classList.remove('active');
        setTimeout(() => this.element.remove(), 200);
    }
}