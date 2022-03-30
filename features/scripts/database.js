let redirect_page;

function Init_Database(page) {
    redirect_page = page;

    let trashs = document.getElementsByName('trash');
    for (let i = 0; i < trashs.length; i++) {
        trashs[i].onclick = () => Trash_Click(trashs[i]);
    }

    let cells = document.getElementsByName('cell');
    for (let i = 0; i < cells.length; i++) {
        cells[i].onclick = () => Cell_Click(cells[i]);
        cells[i].onfocus = () => Cell_Click(cells[i]);
    }
}

function Trash_Click(element) {
    if (typeof(element.sure) === 'undefined') {
        element.sure = setTimeout(() => {
            element.sure = undefined;
            element.classList.remove('red');
        }, 5000);
        element.classList.add('red');
    } else {
        let id = element.getAttribute('idcell');
        let table = element.getAttribute('table');
        LoadPage(redirect_page, { 'rem': id, 'table': table});
    }
}

function Cell_Click(cell) {
    if (typeof(cell.isFocus) === 'undefined') {
        cell.isFocus = true;

        // Get initial value
        let value = cell.innerHTML;

        // Replace text with textinput
        cell.innerHTML = '<input class="form-control" type="text" value="">';
        let input = cell.getElementsByTagName('input')[0];
        input.focus();
        input.value = value;
        input.select();

        // Add event - valid
        function Valid() {
            let newValue = input.value;
            if (value != newValue) {
                let cellID = cell.getAttribute('idcell');
                let column = cell.getAttribute('column');
                let table = cell.getAttribute('dbname');
                LoadPage(redirect_page, { 'edit': cellID, 'column': column, 'table': table, 'content': newValue }, false, true);
            }
            cell.innerHTML = newValue;
            cell.isFocus = undefined;
        };
        input.onfocusout = Valid;
        input.onkeydown = (ev) => {
            //console.log(ev);
            if (ev.keyCode === 13) {
                Valid();
            }
            if (ev.keyCode === 9) {
                /*if (ev.shiftKey) {
                    console.log("?");
                    Valid();
                }*/
                Valid();
            }
        };
    }
}