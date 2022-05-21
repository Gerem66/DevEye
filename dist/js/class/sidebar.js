class Sidebar {
    /** @param {Page} parent */
    constructor(parent) {
        this.parent = parent;
    }

    Init() {
        /** @type {HTMLElement} Sidebar element */
        this.sidebar = document.getElementById('sidebar');

        /** @type {NodeListOf<HTMLElement>} List of all features in sidebar */
        this.navbarItems = document.getElementsByName('sidebar-item');
        this.navbarItems.forEach(item => {
            const element = Array.from(item.getElementsByTagName('a'));
            if (element.length <= 0) {
                return;
            }
            element[0].onclick = () => this.eventOnItemClick(item);
        });

        /** @type {NodeListOf<HTMLElement>} List of features groups wich can be collapse/expand */
        this.navbarGroups = document.getElementsByName('sidebar-group');
        this.navbarGroups.forEach(group => {
            const element = Array.from(group.getElementsByTagName('a'));
            if (element.length <= 0) {
                return;
            }
            element[0].onclick = () => this.eventOnGroupClick(group);
        });

        /** @type {HTMLElement} Button to collapse/expand sidebar */
        this.buttonSidebar = document.getElementById('button-sidebar');
        this.buttonSidebar.onclick = () => this.ButtonSidebar();

        // Disable icon drag
        const img = document.getElementById('image-profile-sidebar');
        img.onmousedown = (e) => e.preventDefault();
    }

    /** @param {HTMLElement} item */
    eventOnItemClick(item) {
        const dataPage = item.getAttribute('data-page');
        const dataCategory = item.getAttribute('data-category') || null;
        this.parent.Load(dataPage, dataCategory);
    }
    /** @param {HTMLElement} group */
    eventOnGroupClick(group) {
        group.classList.toggle('active');

        const ulGroup = Array.from(group.getElementsByTagName('ul'));
        if (ulGroup.length <= 0) {
            return;
        }

        // Expand/collapse group if exists
        if (group.classList.contains('active')) {
            let subItems = [];
            for (let i = 0; i < ulGroup[0].children.length; i++) {
                if (ulGroup[0].children[i].tagName === 'LI') {
                    subItems.push(ulGroup[0].children[i]);
                }
            }
            const height = subItems.map(item => item.offsetHeight).reduce((a, b) => a + b, 0);
            const parent = ulGroup[0].parentNode.parentNode;
            if (parent.tagName === 'UL') {
                parent.style.height = parseInt(parent.style.height) + height + 'px';
            }
            ulGroup[0].style.height = height + 'px';
        } else {
            const parent = ulGroup[0].parentNode.parentNode;
            if (parent.tagName === 'UL') {
                parent.style.height = parseInt(parent.style.height) - parseInt(ulGroup[0].style.height) + 'px';
            }
            ulGroup[0].style.height = '0px';
        }
    }

    HideSidebarOnSmallScreen() {
        // Hide sidebar on small screens
        if (document.body.getBoundingClientRect().width <= 800 && this.sidebar.classList.contains('collapse-sidebar')) {
            this.ButtonSidebar();
        }
    }
    ButtonSidebar() {
        this.sidebar.classList.toggle('collapse-sidebar');
        this.parent.topbar.classList.toggle('with-minibar');
        this.parent.content.classList.toggle('with-minibar');
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