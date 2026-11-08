const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

for (const el of document.querySelectorAll('time[data-ts]')) {
  const ts = Number(el.dataset.ts);
  const overdue = 'next' in el.dataset && ts <= Date.now();
  el.textContent = overdue ? 'any moment' : format.format(ts);
}

for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    if (!confirm(form.dataset.confirm)) event.preventDefault();
  });
}

const copyButton = document.getElementById('copy');
copyButton.addEventListener('click', async () => {
  const box = document.getElementById('config');
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    box.select();
    document.execCommand('copy');
  }
  copyButton.textContent = 'Copied';
  setTimeout(() => {
    copyButton.textContent = 'Copy JSON';
  }, 1500);
});
