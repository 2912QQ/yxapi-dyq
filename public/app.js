const form = document.getElementById('generator-form');
const submitBtn = document.getElementById('submitBtn');
const fillDemoBtn = document.getElementById('fillDemoBtn');
const resultSection = document.getElementById('resultSection');
const warningBox = document.getElementById('warningBox');
const previewBody = document.getElementById('previewBody');
const autoUrl = document.getElementById('autoUrl');
const rawUrl = document.getElementById('rawUrl');
const clashUrl = document.getElementById('clashUrl');
const surgeUrl = document.getElementById('surgeUrl');
const emptyState = document.getElementById('emptyState');
const qrModal = document.getElementById('qrModal');
const qrCanvas = document.getElementById('qrCanvas');
const qrText = document.getElementById('qrText');
const closeQrModal = document.getElementById('closeQrModal');
const preferredApiUrl = document.getElementById('preferredApiUrl');
const fetchPreferredApiBtn = document.getElementById('fetchPreferredApiBtn');
const preferredApiStatus = document.getElementById('preferredApiStatus');

const demoVmess = [
  'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vLXdzLXRscyIsCiAgImFkZCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAicG9ydCI6ICI0NDMiLAogICJpZCI6ICIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLAogICJzY3kiOiAiYXV0byIsCiAgIm5ldCI6ICJ3cyIsCiAgInRscyI6ICJ0bHMiLAogICJwYXRoIjogIi93cyIsCiAgImhvc3QiOiAiZWRnZS5leGFtcGxlLmNvbSIsCiAgInNuaSI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAiZnAiOiAiY2hyb21lIiwKICAiYWxwbiI6ICJoMixodHRwLzEuMSIKfQ=='
].join('\n');

const demoIps = [
  '104.16.1.2#HK-01',
  '104.17.2.3#HK-02',
  '104.18.3.4:2053#US-Edge'
].join('\n');

fillDemoBtn.addEventListener('click', () => {
  document.getElementById('nodeLinks').value = demoVmess;
  document.getElementById('preferredIps').value = demoIps;
  document.getElementById('namePrefix').value = 'CF';
  document.getElementById('keepOriginalHost').checked = true;
});

fetchPreferredApiBtn.addEventListener('click', async () => {
  const apiUrl = preferredApiUrl.value.trim();
  if (!apiUrl) {
    setApiStatus('请先填写优选 API 地址。', true);
    preferredApiUrl.focus();
    return;
  }
  if (!/^https?:\/\//i.test(apiUrl)) {
    setApiStatus('API 地址必须以 http:// 或 https:// 开头。', true);
    return;
  }

  fetchPreferredApiBtn.disabled = true;
  fetchPreferredApiBtn.textContent = '获取中...';
  setApiStatus('正在请求优选 API...', false);

  try {
    const response = await fetch('/api/fetch-preferred', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: apiUrl }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || '获取优选 IP 失败');
    }

    const textarea = document.getElementById('preferredIps');
    const current = textarea.value.trim();
    const incoming = Array.isArray(data.items) ? data.items.join('\n') : '';
    textarea.value = current ? `${current}\n${incoming}` : incoming;
    setApiStatus(`成功获取 ${data.items.length} 个优选地址，已追加到优选框。`, false);
  } catch (error) {
    setApiStatus(error.message || '请求失败，请检查 API 地址。', true);
  } finally {
    fetchPreferredApiBtn.disabled = false;
    fetchPreferredApiBtn.textContent = '获取优选 IP';
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  warningBox.classList.add('hidden');
  previewBody.innerHTML = '';

  const payload = {
    nodeLinks: document.getElementById('nodeLinks').value,
    preferredIps: document.getElementById('preferredIps').value,
    namePrefix: document.getElementById('namePrefix').value,
    keepOriginalHost: document.getElementById('keepOriginalHost').checked,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = '生成中...';

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '生成失败');

    autoUrl.value = data.urls.auto;
    rawUrl.value = data.urls.raw;
    document.getElementById('rocketUrl').value = data.urls.raw;
    clashUrl.value = data.urls.clash;
    surgeUrl.value = data.urls.surge;
    emptyState.classList.add('hidden');
    document.getElementById('statInputNodes').textContent = data.counts.inputNodes;
    document.getElementById('statEndpoints').textContent = data.counts.preferredEndpoints;
    document.getElementById('statOutputNodes').textContent = data.counts.outputNodes;

    previewBody.innerHTML = data.preview.map((item) => `
      <tr>
        <td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.server)}</td><td>${escapeHtml(String(item.port))}</td>
        <td>${escapeHtml(item.host || '-')}</td><td>${escapeHtml(item.sni || '-')}</td>
      </tr>`).join('');

    if (Array.isArray(data.warnings) && data.warnings.length) {
      warningBox.textContent = data.warnings.join('\n');
      warningBox.classList.remove('hidden');
    }
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    warningBox.textContent = error.message || '请求失败';
    warningBox.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '生成订阅';
  }
});

document.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy-target]');
  if (copyButton) {
    const input = document.getElementById(copyButton.dataset.copyTarget);
    if (!input?.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      const originalText = copyButton.textContent;
      copyButton.textContent = '已复制';
      setTimeout(() => { copyButton.textContent = originalText; }, 1200);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    return;
  }

  const qrButton = event.target.closest('[data-qrcode-target]');
  if (qrButton) {
    warningBox.classList.add('hidden');
    const input = document.getElementById(qrButton.dataset.qrcodeTarget);
    if (!input?.value) {
      warningBox.textContent = '请先生成订阅链接，再显示二维码。';
      warningBox.classList.remove('hidden');
      return;
    }
    if (!window.QRCode) {
      warningBox.textContent = '二维码组件加载失败，请刷新页面后重试。';
      warningBox.classList.remove('hidden');
      return;
    }
    qrCanvas.innerHTML = '';
    qrText.textContent = input.value;
    qrModal.classList.remove('hidden');
    qrModal.setAttribute('aria-hidden', 'false');
    new window.QRCode(qrCanvas, {
      text: input.value, width: 220, height: 220,
      correctLevel: window.QRCode.CorrectLevel.M,
    });
    return;
  }
  if (event.target.closest('[data-close-modal="true"]')) closeQrDialog();
});

closeQrModal.addEventListener('click', closeQrDialog);

function closeQrDialog() {
  qrModal.classList.add('hidden');
  qrModal.setAttribute('aria-hidden', 'true');
  qrCanvas.innerHTML = '';
}

function setApiStatus(message, isError) {
  preferredApiStatus.textContent = message;
  preferredApiStatus.classList.toggle('error', Boolean(isError));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
