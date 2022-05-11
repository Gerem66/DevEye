function CopyContent(text) {
    navigator.clipboard.writeText(text)
    .then(() => window.location.reload())
    .catch(console.error);
}

function PreventResubmissionAlert() {
    if (window.history.replaceState) {
        window.history.replaceState(null, null, window.location.href);
    }
}