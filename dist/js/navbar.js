class Navbar {
    /** @param {Page} page */
    constructor(page) {
        this.page = page;
        this.items = document.getElementsByName('sidebar-item');
        this.last_selected = -1;
    }

    setEventsSidebarItems() {
        for (let i = 0; i < this.items.length; i++) {
            this.items[i].onclick = () => {
                this.page.Load(this.items[i].getAttribute('data-page'));
            };
        }
    }

    SetActiveItem(page) {
        this.ClearActiveItems();
        this.last_selected = page;
        for (let i = 0; i < this.items.length; i++) {
            if (page.startsWith(this.items[i].getAttribute('data-page'))) {
                this.items[i].classList.add('active');
                this.last_selected = i;
                break;
            }
        }
    }

    ClearActiveItems() {
        if (this.last_selected !== -1) {
            this.items[this.last_selected].classList.remove('active');
            this.last_selected = -1;
        }
    }
}