class Sidebar {
    /** @param {Page} parent */
    constructor(parent) {
        this.parent = parent;
    }

    Init() {
        /** @type {NodeListOf<HTMLElement>} */
        this.navbarItems = document.getElementsByName('sidebar-item');
        this.navbarItems.forEach(item => {
            const element = Array.from(item.getElementsByTagName('a'));
            if (element.length <= 0) {
                return;
            }
            element[0].onclick = () => this.eventOnItemClick(item);
        });

        /** @type {NodeListOf<HTMLElement>} */
        this.navbarGroups = document.getElementsByName('sidebar-group');
        this.navbarGroups.forEach(group => {
            const element = Array.from(group.getElementsByTagName('a'));
            if (element.length <= 0) {
                return;
            }
            element[0].onclick = () => this.eventOnGroupClick(group);
        });
    }

    /** @param {HTMLElement} item */
    eventOnItemClick(item) {
        const dataPage = item.getAttribute('data-page');
        const dataCategory = item.getAttribute('data-category') || null;
        this.parent.Load(dataPage, dataCategory);
    }
    /** @param {HTMLElement} item */
    eventOnGroupClick(group) {
        group.classList.toggle('active');

        const ulGroup = Array.from(group.getElementsByTagName('ul'));
        if (ulGroup.length <= 0) {
            return;
        }

        // Expand/collapse group if exists
        if (group.classList.contains('active')) {
            const subItems = Array.from(group.getElementsByTagName('li'));
            const height = subItems.map(item => item.offsetHeight).reduce((a, b) => a + b, 0);
            ulGroup[0].style.height = height + 'px';
        } else {
            ulGroup[0].style.height = '0px';
        }
    }

    /** @param {Pages} page */
    SetActiveItem(page, category = null) {
        this.ClearActiveItems();

        const items = Array.from(this.navbarItems);
        const itemsPage = items.filter(item => item.getAttribute('data-page') === page);
        const itemsCategory = itemsPage.filter(item => item.getAttribute('data-category') || null === category);

        if (itemsCategory.length > 0) {
            itemsCategory[0].classList.add('active');
        } else if (itemsPage.length > 0) {
            itemsPage[0].classList.add('active');
        }
    }
    ClearActiveItems() {
        this.navbarItems.forEach(item => {
            if (item.classList.contains('active')) {
                item.classList.remove('active');
            }
        });
    }
}