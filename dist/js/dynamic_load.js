let main_content = document.getElementById('main-content');
let sidebar_items = document.getElementsByName('sidebar-item');
let last_selected = -1;
let loading = false;

function AsyncLoad() {
    main_content.classList.add('small-loading');
}
function AsyncLoaded() {
    main_content.classList.remove('small-loading');
}

function PreLoadPage() {
    main_content.classList.add('loading');
}
function LoadPage(page, data = null, afterRefresh = false, noLoadPage = false, callback = undefined) {
    if (loading) return;

    loading = true;
    ClearInterval();
    if (!noLoadPage) {
        PreLoadPage();
    }

    // Clear active item
    if (last_selected != -1)
        sidebar_items[last_selected].classList.remove('active');

    let params = null;
    if (data != null) {
        let fd = new FormData();
        for (let i in data) {
            fd.append(i, data[i]);
        }
        params = { method: 'POST', body: fd };
    }

    fetch('./' + page, params)
        .then(function(response) { return response.text(); })
        .then(function(content) {
            if (afterRefresh || content == 'disconnect') {
                window.location.reload();
            }

            loading = false;
            if (!noLoadPage) {
                main_content.innerHTML = content;
                InitPage(page);
                main_content.classList.remove('loading');
            }

            // Set active item
            for (let i = 0; i < sidebar_items.length; i++) {
                if (page.startsWith(sidebar_items[i].getAttribute('data-page'))) {
                    sidebar_items[i].classList.add('active');
                    last_selected = i;
                    break;
                }
            }
        })
        .finally(function() {
            if (typeof(callback) === "function") {
                callback();
            }
        });
}

function InitPage(page) {
    switch (page) {
        case 'user': Init_User(); break;
        case 'dashboard': Init_Dashboard(); break;
        case 'projects-edit': Init_Projects_Edit(); break;
        case 'projects-kanban': Init_Projects_Kanban(); break;
        case 'projects-changelog': Init_Projects_Changelog(); break;
        case 'washing-machine': AutoRefresh(page); break;
        case 'database': Init_Database(page); break;
        case 'database-gl': Init_Database(page); break;
        case 'database-dev-gl': Init_Database(page); break;
        case 'settings': Init_Settings(); break;
    }
}