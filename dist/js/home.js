var page = new Page();

window.onload = () => {
    page.Init();
    page.Load('user');
}

// Mails... ?
/*const MainContent = {
    asyncLoad: () => main_content.classList.add('small-loading'),
    asyncLoaded: () => main_content.classList.remove('small-loading'),
};
function AsyncLoad() { main_content.classList.add('small-loading'); }
function AsyncLoaded() { main_content.classList.remove('small-loading'); }
function PreLoadPage() { main_content.classList.add('loading'); }*/