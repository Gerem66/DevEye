function CopyContent(text) {
    navigator.clipboard.writeText(text)
    .then(() => window.location.reload())
    .catch(console.error);
}