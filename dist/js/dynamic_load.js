let main_content = document.getElementById('main-content');
let sidebar_items = document.getElementsByName('sidebar-item');
let last_selected = -1;
let loading = false;

let timer_interval;
let timer_seconds;
let timer_element;

let pagesWithAutoRefresh = [ 'washing-machine' ]

function AsyncLoad() {
    main_content.classList.add('small-loading');
}
function AsyncLoaded() {
    main_content.classList.remove('small-loading');
}

function PreLoadPage() {
    main_content.classList.add('loading');
}
function LoadPage(page, data = null, afterRefresh = false, noLoadPage = false) {
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
                if (typeof(Init) === 'function') Init();
                main_content.classList.remove('loading');
            }

            // Auto refresh
            if (pagesWithAutoRefresh.includes(page)) {
                AutoRefresh(page, params);
            }

            // Set active item
            for (let i = 0; i < sidebar_items.length; i++) {
                if (page.startsWith(sidebar_items[i].getAttribute('data-page'))) {
                    sidebar_items[i].classList.add('active');
                    last_selected = i;
                    break;
                }
            }
        });
}

function SavePasswords(team = 0) {
    let content = document.getElementById('inputContent').value;
    LoadPage('passwords', { save: '1', 'team': team, 'tb_content': content});
}
function SaveLogbook(team = 0) {
    let content = document.getElementById('inputContent').value;
    LoadPage('logbook', { save: '1', 'team': team, 'tb_content': content});
}
function SquareClick(element, team = 0) {
    function SwitchSquare() {
        element.classList.toggle('fa-square');
        element.classList.toggle('fa-check-square');
    }

    let id = element.id;
    SwitchSquare();
    element.style.color = 'grey';

    let fd = new FormData();
    fd.append('square_toggle', id);
    fd.append('team', team);
    params = { method: 'POST', body: fd };

    fetch('./logbook', params)
        .then(function(response) { return response.text(); })
        .then(function(content) {
            if (content != 'OK') {
                SwitchSquare();
            }
        })
        .catch(function(err) {
            console.error(err);
            SwitchSquare();
        })
        .finally(function() {
            element.style.color = 'white';
        });
}


// Auto-refresh
function ClearInterval() {
    if (typeof(timer_interval) !== 'undefined') {
        clearInterval(timer_interval);
        timer_interval = undefined;
        timer_element = undefined;
    }
}
function AutoRefresh(page, params) {
    function tick() {
        timer_seconds -= 1;
        if (timer_element != null)
            timer_element.innerHTML = timer_seconds;
        if (timer_seconds == 0)
            LoadPage(page, params);
    }

    timer_element = document.getElementById('timer');
    timer_seconds = 60;
    tick();
    timer_interval = setInterval(tick, 1000);
}