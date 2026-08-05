const $ = (id) => document.getElementById(id)

function getSettings() {
  return new Promise((resolve) => chrome.storage.local.get(['backendUrl', 'adminKey'], resolve))
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function syncCurrentSite() {
  const status = $('status')
  const { backendUrl, adminKey } = await getSettings()
  if (!backendUrl || !adminKey) {
    status.textContent = 'Set your TubeVault URL + ADMIN_API_KEY in Settings first.'
    return
  }

  const tab = await getActiveTab()
  if (!tab?.url) {
    status.textContent = 'No active tab URL.'
    return
  }

  let hostname
  try {
    hostname = new URL(tab.url).hostname
  } catch {
    status.textContent = 'This page has no cookies to read (chrome:// / extension page?).'
    return
  }
  $('site').textContent = hostname

  status.textContent = 'Reading cookies...'
  const cookies = await chrome.cookies.getAll({ url: tab.url })
  if (!cookies.length) {
    status.textContent = `No cookies found for ${hostname}.`
    return
  }

  status.textContent = `Sending ${cookies.length} cookie(s)...`
  try {
    const res = await fetch(`${backendUrl.replace(/\/+$/, '')}/api/admin/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ cookies }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    status.textContent = `Synced ${data.added} cookie(s) for ${hostname}.\n(${data.total} total now in the file.)`
  } catch (err) {
    status.textContent = `Failed: ${err.message}`
  }
}

document.getElementById('sync').addEventListener('click', syncCurrentSite)

getActiveTab().then((tab) => {
  try {
    $('site').textContent = new URL(tab.url).hostname
  } catch {
    $('site').textContent = '(unsupported page)'
  }
})
