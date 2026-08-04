const $ = (id) => document.getElementById(id)

chrome.storage.local.get(['backendUrl', 'adminKey'], ({ backendUrl, adminKey }) => {
  if (backendUrl) $('backendUrl').value = backendUrl
  if (adminKey) $('adminKey').value = adminKey
})

$('save').addEventListener('click', () => {
  const backendUrl = $('backendUrl').value.trim()
  const adminKey = $('adminKey').value.trim()
  chrome.storage.local.set({ backendUrl, adminKey }, () => {
    $('saved').textContent = 'Saved.'
    setTimeout(() => { $('saved').textContent = '' }, 1500)
  })
})
