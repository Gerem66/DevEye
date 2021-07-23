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