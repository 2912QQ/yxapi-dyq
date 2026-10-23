// Cloudflare Worker: KV short link subscription + preferred IP API
// Requires KV binding: SUB_STORE
// Optional secret/variable: SUB_ACCESS_TOKEN

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType, 'access-control-allow-origin': '*' },
  });
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(str) {
  const normalized = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

function escapeYaml(str = '') {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function parseEndpointLine(line) {
  const [raw, ...remarkParts] = String(line).split('#');
  let value = raw.trim();
  const remark = remarkParts.join('#').trim();
  let port;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close > 0 && /^:\d+$/.test(value.slice(close + 1))) {
      port = Number(value.slice(close + 2));
      value = value.slice(0, close + 1);
    }
  } else {
    const match = value.match(/^(.*):([0-9]{1,5})$/);
    if (match && !match[1].includes(':')) {
      value = match[1];
      port = Number(match[2]);
    }
  }

  if (!value) return null;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return { server: value, port, remark };
}

function parsePreferredEndpoints(input) {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseEndpointLine)
    .filter(Boolean);
}

function normalizeEndpointCandidate(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = parseEndpointLine(line);
      return parsed ? [parsed] : [];
    });
}

function collectApiCandidates(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return normalizeEndpointCandidate(value);
  if (Array.isArray(value)) return value.flatMap((item) => collectApiCandidates(item, depth + 1));
  if (typeof value !== 'object') return [];

  const priorityKeys = ['ips', 'ip', 'data', 'result', 'list', 'items', 'addresses', 'proxies', 'nodes'];
  const out = [];
  for (const key of priorityKeys) {
    if (key in value) out.push(...collectApiCandidates(value[key], depth + 1));
  }
  if (!out.length) {
    for (const item of Object.values(value)) out.push(...collectApiCandidates(item, depth + 1));
  }
  return out;
}

function dedupeEndpoints(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.server}|${item.port || ''}|${item.remark || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatEndpoint(item) {
  const value = item.port ? `${item.server}:${item.port}` : item.server;
  return item.remark ? `${value}#${item.remark}` : value;
}

function isUnsafeApiHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === 'localhost.localdomain') return true;
  if (host === 'metadata.google.internal' || host === 'instance-data.ec2.internal') return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  return false;
}

async function handleFetchPreferred(request) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '请求体不是合法 JSON' }, 400); }

  let target;
  try {
    target = new URL(String(body.url || '').trim());
  } catch {
    return json({ ok: false, error: '优选 API 地址无效' }, 400);
  }
  if (!['http:', 'https:'].includes(target.protocol)) return json({ ok: false, error: 'API 只支持 HTTP/HTTPS' }, 400);
  if (isUnsafeApiHost(target.hostname)) return json({ ok: false, error: 'API 地址不允许访问本机或内网地址' }, 400);

  try {
    const response = await fetch(target.toString(), {
      method: 'GET',
      headers: { accept: 'application/json,text/plain,*/*', 'user-agent': 'CloudflareSub-PreferredIP/1.0' },
      redirect: 'follow',
    });
    if (!response.ok) return json({ ok: false, error: `优选 API 返回 HTTP ${response.status}` }, 502);

    const raw = await response.text();
    if (raw.length > 1024 * 1024) return json({ ok: false, error: 'API 返回内容过大，最大支持 1MB' }, 413);

    let candidates = [];
    try { candidates = collectApiCandidates(JSON.parse(raw)); } catch { candidates = normalizeEndpointCandidate(raw); }
    candidates = dedupeEndpoints(candidates).slice(0, 500);
    if (!candidates.length) return json({ ok: false, error: 'API 返回内容中没有识别到 IP / 域名' }, 422);

    return json({ ok: true, items: candidates.map(formatEndpoint), count: candidates.length });
  } catch (error) {
    return json({ ok: false, error: `请求优选 API 失败：${error?.message || '网络错误'}` }, 502);
  }
}

function parseVmess(link) {
  const obj = JSON.parse(b64DecodeUtf8(link.slice('vmess://'.length).trim()));
  return {
    type: 'vmess', name: obj.ps || 'vmess', server: obj.add, port: Number(obj.port || 443),
    uuid: obj.id, cipher: obj.scy || 'auto', network: obj.net || 'ws', tls: obj.tls === 'tls',
    host: obj.host || '', path: obj.path || '/', sni: obj.sni || obj.host || '', alpn: obj.alpn || '', fp: obj.fp || '',
  };
}

function parseUrlLike(link, type) {
  const u = new URL(link);
  return {
    type, name: decodeURIComponent(u.hash.replace(/^#/, '')) || type, server: u.hostname, port: Number(u.port || 443),
    password: type === 'trojan' ? decodeURIComponent(u.username) : undefined,
    uuid: type === 'vless' ? decodeURIComponent(u.username) : undefined,
    network: u.searchParams.get('type') || 'tcp', tls: (u.searchParams.get('security') || '').toLowerCase() === 'tls',
    host: u.searchParams.get('host') || u.searchParams.get('sni') || '', path: u.searchParams.get('path') || '/',
    sni: u.searchParams.get('sni') || u.searchParams.get('host') || '', fp: u.searchParams.get('fp') || '',
    alpn: u.searchParams.get('alpn') || '', flow: u.searchParams.get('flow') || '',
  };
}

function parseRawLinks(input) {
  const lines = String(input || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result = [];
  for (const line of lines) {
    try {
      if (line.startsWith('vmess://')) result.push(parseVmess(line));
      else if (line.startsWith('vless://')) result.push(parseUrlLike(line, 'vless'));
      else if (line.startsWith('trojan://')) result.push(parseUrlLike(line, 'trojan'));
      else {
        const decoded = b64DecodeUtf8(line);
        if (/^(vmess|vless|trojan):\/\//m.test(decoded)) result.push(...parseRawLinks(decoded));
      }
    } catch {}
  }
  return result;
}

function buildNodes(baseNodes, preferredEndpoints, options = {}) {
  const output = [];
  const prefix = (options.namePrefix || '').trim();
  let counter = 0;
  for (const node of baseNodes) for (const ep of preferredEndpoints) {
    counter += 1;
    const nameParts = [];
    if (node.name) nameParts.push(node.name);
    if (prefix) nameParts.push(prefix);
    nameParts.push(ep.remark || String(counter));
    output.push({ ...node, name: nameParts.join(' | '), server: ep.server, port: ep.port || node.port,
      host: options.keepOriginalHost ? node.host : '', sni: options.keepOriginalHost ? node.sni : '' });
  }
  return output;
}

function encodeVmess(node) {
  return 'vmess://' + b64EncodeUtf8(JSON.stringify({ v:'2', ps:node.name, add:node.server, port:String(node.port), id:node.uuid,
    aid:'0', scy:node.cipher||'auto', net:node.network||'ws', type:'none', host:node.host||'', path:node.path||'/',
    tls:node.tls?'tls':'', sni:node.sni||'', alpn:node.alpn||'', fp:node.fp||'' }));
}

function encodeVless(node) {
  const u = new URL(`vless://${encodeURIComponent(node.uuid)}@${node.server}:${node.port}`);
  u.searchParams.set('type', node.network || 'ws'); if (node.tls) u.searchParams.set('security','tls');
  if (node.host) u.searchParams.set('host',node.host); if (node.sni) u.searchParams.set('sni',node.sni);
  if (node.path) u.searchParams.set('path',node.path); if (node.alpn) u.searchParams.set('alpn',node.alpn);
  if (node.fp) u.searchParams.set('fp',node.fp); if (node.flow) u.searchParams.set('flow',node.flow); u.hash=node.name; return u.toString();
}

function encodeTrojan(node) {
  const u = new URL(`trojan://${encodeURIComponent(node.password)}@${node.server}:${node.port}`);
  if (node.network) u.searchParams.set('type',node.network); if (node.tls) u.searchParams.set('security','tls');
  if (node.host) u.searchParams.set('host',node.host); if (node.sni) u.searchParams.set('sni',node.sni);
  if (node.path) u.searchParams.set('path',node.path); if (node.alpn) u.searchParams.set('alpn',node.alpn);
  if (node.fp) u.searchParams.set('fp',node.fp); u.hash=node.name; return u.toString();
}

function renderRaw(nodes) {
  return b64EncodeUtf8(nodes.map((n) => n.type==='vmess'?encodeVmess(n):n.type==='vless'?encodeVless(n):n.type==='trojan'?encodeTrojan(n):'').filter(Boolean).join('\n'));
}

function renderClash(nodes) {
  const proxies = nodes.map((node) => {
    if (node.type === 'vmess') {
      const x = [`  - name: "${escapeYaml(node.name)}"`,`    type: vmess`,`    server: ${node.server}`,`    port: ${node.port}`,
        `    uuid: ${node.uuid}`,`    alterId: 0`,`    cipher: ${node.cipher||'auto'}`,`    udp: true`,`    tls: ${node.tls?'true':'false'}`,`    network: ${node.network||'ws'}`];
      if (node.sni) x.push(`    servername: "${escapeYaml(node.sni)}"`);
      if ((node.network||'ws')==='ws') x.push(`    ws-opts:`,`      path: "${escapeYaml(node.path||'/')}"`,`      headers:`,`        Host: "${escapeYaml(node.host||node.sni||'')}"`);
      return x.join('\n');
    }
    if (node.type === 'vless') {
      const x = [`  - name: "${escapeYaml(node.name)}"`,`    type: vless`,`    server: ${node.server}`,`    port: ${node.port}`,`    uuid: ${node.uuid}`,
        `    udp: true`,`    tls: ${node.tls?'true':'false'}`,`    network: ${node.network||'ws'}`];
      if (node.sni) x.push(`    servername: "${escapeYaml(node.sni)}"`);
      if ((node.network||'ws')==='ws') x.push(`    ws-opts:`,`      path: "${escapeYaml(node.path||'/')}"`,`      headers:`,`        Host: "${escapeYaml(node.host||node.sni||'')}"`);
      return x.join('\n');
    }
    if (node.type === 'trojan') {
      const x = [`  - name: "${escapeYaml(node.name)}"`,`    type: trojan`,`    server: ${node.server}`,`    port: ${node.port}`,
        `    password: "${escapeYaml(node.password||'')}"`,`    udp: true`];
      if (node.sni) x.push(`    sni: "${escapeYaml(node.sni)}"`); if (node.tls !== false) x.push(`    tls: true`);
      if (node.network) x.push(`    network: ${node.network}`);
      if (node.network==='ws') x.push(`    ws-opts:`,`      path: "${escapeYaml(node.path||'/')}"`,`      headers:`,`        Host: "${escapeYaml(node.host||node.sni||'')}"`);
      return x.join('\n');
    }
    return '';
  }).filter(Boolean);
  const names = nodes.map((n)=>`      - "${escapeYaml(n.name)}"`);
  return [`mixed-port: 7890`,`allow-lan: false`,`mode: rule`,`log-level: info`,`ipv6: true`,'',`proxies:`,...proxies,'',`proxy-groups:`,
    `  - name: "自动选择"`,`    type: url-test`,`    url: "http://www.gstatic.com/generate_204"`,`    interval: 300`,`    tolerance: 50`,`    proxies:`,...(names.length?names:[`      - DIRECT`]),'',
    `  - name: "节点选择"`,`    type: select`,`    proxies:`,`      - "自动选择"`,...names,`      - DIRECT`,'',`rules:`,`  - MATCH,节点选择`].join('\n');
}

function renderSurge(nodes, baseUrl, accessToken) {
  const proxies = nodes.filter(n=>n.type==='vmess'||n.type==='trojan').map(n=>n.type==='vmess'
    ? `${n.name} = vmess, ${n.server}, ${n.port}, username=${n.uuid}, ws=true, ws-path=${n.path||'/'}, ws-headers=Host:${n.host||''}, tls=${n.tls?'true':'false'}, sni=${n.sni||''}`
    : `${n.name} = trojan, ${n.server}, ${n.port}, password=${n.password||''}, sni=${n.sni||''}`);
  const names = nodes.filter(n=>n.type==='vmess'||n.type==='trojan').map(n=>n.name).join(', ');
  return ['[General]','skip-proxy = 127.0.0.1, localhost','', '[Proxy]',...proxies,'','[Proxy Group]',`Proxy = select, ${names}`,'','[Rule]','FINAL,Proxy','', '; token-protected subscription',`; ${baseUrl}?token=${accessToken}`].join('\n');
}

function createShortId(length=10) {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; const bytes=crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b=>chars[b%chars.length]).join('');
}

async function createUniqueShortId(env) {
  for (let i=0;i<8;i++) { const id=createShortId(); if (!(await env.SUB_STORE.get(`sub:${id}`))) return id; }
  throw new Error('无法生成唯一短链接，请稍后再试');
}

function normalizeLines(value='') { return String(value).split(/\r?\n/).map(x=>x.trim()).filter(Boolean).sort().join('\n'); }
async function sha256Hex(input) { const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input)); return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function buildDedupHash(body) { return sha256Hex(JSON.stringify({ nodeLinks:normalizeLines(body.nodeLinks||''), preferredIps:normalizeLines(body.preferredIps||''), namePrefix:String(body.namePrefix||'').trim(), keepOriginalHost:body.keepOriginalHost!==false })); }

async function handleGenerate(request, env, url) {
  let body; try { body=await request.json(); } catch { return json({ok:false,error:'请求体不是合法 JSON'},400); }
  const baseNodes=parseRawLinks(body.nodeLinks||''); const preferredEndpoints=parsePreferredEndpoints(body.preferredIps||'');
  if (!baseNodes.length) return json({ok:false,error:'没有识别到可用节点'},400);
  if (!preferredEndpoints.length) return json({ok:false,error:'没有识别到可用优选地址'},400);
  const options={namePrefix:body.namePrefix||'',keepOriginalHost:body.keepOriginalHost!==false}; const nodes=buildNodes(baseNodes,preferredEndpoints,options);
  const payload={version:1,createdAt:new Date().toISOString(),options,nodes}; const dedupKey=`dedup:${await buildDedupHash(body)}`;
  let id=await env.SUB_STORE.get(dedupKey);
  if (!id) { id=await createUniqueShortId(env); const ttl=604800; await env.SUB_STORE.put(`sub:${id}`,JSON.stringify(payload),{expirationTtl:ttl}); await env.SUB_STORE.put(dedupKey,id,{expirationTtl:ttl}); }
  const token=env.SUB_ACCESS_TOKEN||''; const withToken=(target)=>`${url.origin}/sub/${id}${target?`?target=${target}&token=${encodeURIComponent(token)}`:`?token=${encodeURIComponent(token)}`}`;
  return json({ok:true,storage:'kv',deduplicated:true,shortId:id,urls:{auto:withToken(''),raw:withToken('raw'),clash:withToken('clash'),surge:withToken('surge')},counts:{inputNodes:baseNodes.length,preferredEndpoints:preferredEndpoints.length,outputNodes:nodes.length},preview:nodes.slice(0,20).map(n=>({name:n.name,type:n.type,server:n.server,port:n.port,host:n.host||'',sni:n.sni||''})),warnings:token?[]:['未检测到 SUB_ACCESS_TOKEN，订阅链接将没有第二层访问保护。']});
}

function validateAccessToken(url,env) { const expected=env.SUB_ACCESS_TOKEN; if(!expected)return {ok:true}; const provided=url.searchParams.get('token')||''; return provided===expected?{ok:true}:{ok:false,response:text('Forbidden: invalid token',403)}; }

async function handleSub(url,env) {
  const check=validateAccessToken(url,env); if(!check.ok)return check.response; const id=url.pathname.split('/').pop(); if(!id)return text('missing id',400);
  const raw=await env.SUB_STORE.get(`sub:${id}`); if(!raw)return text('not found',404); const record=JSON.parse(raw); const nodes=record.nodes||[]; const target=(url.searchParams.get('target')||'raw').toLowerCase();
  if(target==='clash')return text(renderClash(nodes),200,'text/yaml; charset=utf-8');
  if(target==='surge')return text(renderSurge(nodes,url.origin+url.pathname,env.SUB_ACCESS_TOKEN||''));
  return text(renderRaw(nodes));
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'}});
    if(request.method==='POST'&&url.pathname==='/api/fetch-preferred')return handleFetchPreferred(request);
    if(request.method==='POST'&&url.pathname==='/api/generate')return handleGenerate(request,env,url);
    if(request.method==='GET'&&url.pathname.startsWith('/sub/'))return handleSub(url,env);
    return env.ASSETS.fetch(request);
  },
  
};

