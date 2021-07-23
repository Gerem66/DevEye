function SwitchPasswordVision(element) {
    let parent = element.parentNode.parentNode;
    let input = parent.getElementsByTagName('input')[0];
    let icon = element.getElementsByTagName('i')[0];
    let hidded = input.type == 'password';

    input.type = hidded ? 'text' : 'password';
    icon.classList.remove('fa-eye-slash');
    icon.classList.remove('fa-eye');
    icon.classList.add(hidded ? 'fa-eye' : 'fa-eye-slash')
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