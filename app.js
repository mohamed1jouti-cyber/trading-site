// public/app.js - updated client with transactions download and ban/unban
const API_ROOT = '';

const $ = id => document.getElementById(id);
const fmtEUR = n => Number(n).toLocaleString(undefined, { style:'currency', currency:'EUR', maximumFractionDigits:2 });
const now = () => new Date().toISOString();

let token = localStorage.getItem('token') || null;
let socket = null;
let currentUser = null;
let isAdmin = false;
let latestPrices = {};

// connect socket
function connectSocket(){
  if(socket) socket.disconnect();
  socket = io();
  socket.on('connect', ()=> { if(token) socket.emit('auth', { token }); });
  socket.on('auth_ok', ({ user })=>{ currentUser = user.username; isAdmin = false; renderAfterAuth(); });
  socket.on('chat_history', (msgs)=>{ if(!isAdmin) renderChatMessages(msgs); });
  socket.on('prices', (prices)=>{ latestPrices = prices; renderPrice(prices); });
  socket.on('chat_message', (m)=>{ if(!isAdmin && m.user === currentUser) appendChatLocal(m); if(isAdmin) handleAdminIncomingChat(m); });
  socket.on('balance_updated', (data)=>{ if(!isAdmin && data.username === currentUser) fetchMe(); if(isAdmin) fetchAdminUsers(); });
  socket.on('trade_result', (res)=>{ if(res.ok){ if(!isAdmin) fetchMe(); alert('Trade executed'); } else alert('Trade failed: '+res.reason); });
  socket.on('banned', (data)=>{ if(data.banned){ alert('You have been banned: ' + (data.message||'')); logout(); } else { alert('You have been unbanned'); } });
  socket.on('user_update', ()=>{ if(isAdmin) fetchAdminUsers(); });
}

// API helper
async function api(path, opts={}){
  const headers = opts.headers || {};
  headers['Content-Type'] = 'application/json';
  if(token) headers['Authorization'] = 'Bearer ' + token;
  opts.headers = headers;
  const res = await fetch(path, opts);
  return res;
}

// register/login flows
async function register(username, password){
  const res = await api('/api/register', { method:'POST', body: JSON.stringify({ username, password }) });
  return res.json();
}
async function login(username, password){
  const res = await api('/api/login', { method:'POST', body: JSON.stringify({ username, password }) });
  return res.json();
}
function setTokenAndConnect(t, userObj){
  token = t; localStorage.setItem('token', token); if(userObj && userObj.admin){ isAdmin=true; currentUser='admin'; } connectSocket(); renderAfterAuth();
}
function logout(){ token=null; localStorage.removeItem('token'); currentUser=null; isAdmin=false; if(socket) socket.disconnect(); showView('login'); }

// UI routing
const views = { login: $('view-login'), register: $('view-register'), dashboard: $('view-dashboard'), admin: $('view-admin') };
function showView(name){ Object.values(views).forEach(v=>v.classList.add('hidden')); views[name].classList.remove('hidden'); }

$('nav-login').addEventListener('click', ()=>showView('login'));
$('nav-register').addEventListener('click', ()=>showView('register'));

$('form-register').addEventListener('submit', async (e)=>{ e.preventDefault(); const u=$('register-username').value.trim(), p=$('register-password').value; if(!u||!p) return alert('enter both'); const r = await register(u,p); if(r.token){ alert('registered. please login.'); showView('login'); } else alert('register error: ' + (r.error||'unknown')); });

$('form-login').addEventListener('submit', async (e)=>{ e.preventDefault(); const u=$('login-username').value.trim(), p=$('login-password').value; if(!u||!p) return alert('enter both'); const r = await login(u,p); if(r.token){ setTokenAndConnect(r.token, r.user); } else alert('login failed: ' + (r.error||'unknown')); });

$('to-register').addEventListener('click', ()=>showView('register'));
$('to-login').addEventListener('click', ()=>showView('login'));
$('btn-logout').addEventListener('click', ()=>logout());
$('admin-logout').addEventListener('click', ()=>logout());

// after auth
function renderAfterAuth(){ if(isAdmin) showView('admin'); else showView('dashboard'); if(token) socket.emit('auth',{token}); if(!isAdmin) fetchMe(); if(isAdmin) fetchAdminUsers(); }

// fetch me via admin list as fallback
async function fetchMe(){
  const res = await fetch('/api/admin/users', { headers: { Authorization: 'Bearer ' + token } });
  if(res.ok){
    const arr = await res.json();
    const me = arr.find(x=>x.username===currentUser);
    if(me){ renderWallet(me); renderHistory(me); return; }
  }
}

// render wallet and history
function renderWallet(userObj){
  const wl = $('wallet-list'); wl.innerHTML=''; const balances = userObj.balances||{}; let totalEUR = 0;
  Object.keys(balances).forEach(k=>{ const v = balances[k]||0; const d = document.createElement('div'); d.innerHTML = `<strong>${k}</strong>: ${v}`; wl.appendChild(d); if(k==='EUR') totalEUR += v; else { const pair = `${k}/EUR`; const rate = latestPrices[pair] || 0; totalEUR += v * rate; } });
  $('total-eur').textContent = fmtEUR(totalEUR);
}
function renderHistory(userObj){ const hist = $('history'); hist.innerHTML=''; (userObj.history||[]).slice().reverse().forEach(h=>{ const d=new Date(h.date).toLocaleString(); const div=document.createElement('div'); if(h.type==='deposit'||h.type==='withdraw') div.textContent = `${d} — ${h.type.toUpperCase()} ${h.amount} ${h.currency||'EUR'}`; else if(h.type==='buy'||h.type==='sell') div.textContent = `${d} — ${h.type.toUpperCase()} ${h.amountBase||h.amount} ${h.pair} @ ${fmtEUR(h.price)}`; else div.textContent = `${d} — ${JSON.stringify(h)}`; hist.appendChild(div); }); }

// price rendering
function renderPrice(prices){ const p = prices && prices[$('pair-select').value] ? prices[$('pair-select').value] : 0; $('current-price').textContent = fmtEUR(p); drawPriceCanvas(); }
function drawPriceCanvas(){ const canvas=$('price-canvas'); const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); if(!latestPrices || !latestPrices[$('pair-select').value]) return; ctx.fillStyle='#7dd3fc'; ctx.fillRect(10,10,6,6); }

$('pair-select').addEventListener('change', ()=>{ if(latestPrices) renderPrice(latestPrices); });

// trades
$('btn-buy').addEventListener('click', ()=>{ const amt = parseFloat($('manual-amount').value)||0; if(amt<=0) return alert('Enter >0'); socket.emit('trade', { token, pair: $('pair-select').value, type:'buy', amountBase: amt }); });
$('btn-sell').addEventListener('click', ()=>{ const amt = parseFloat($('manual-amount').value)||0; if(amt<=0) return alert('Enter >0'); socket.emit('trade', { token, pair: $('pair-select').value, type:'sell', amountBase: amt }); });

// bot (client-side simple trigger)
let botTimer = null;
$('btn-start-bot').addEventListener('click', ()=>{ if(botTimer) return; $('btn-start-bot').disabled=true; $('btn-stop-bot').disabled=false; botTimer=setInterval(()=>{ const rand=Math.random(); const amt=parseFloat($('trade-size').value)||1; if(rand>0.5) socket.emit('trade',{token,pair:$('pair-select').value,type:'buy',amountBase:amt}); else socket.emit('trade',{token,pair:$('pair-select').value,type:'sell',amountBase:amt}); },5000); });
$('btn-stop-bot').addEventListener('click', ()=>{ if(!botTimer) return; clearInterval(botTimer); botTimer=null; $('btn-start-bot').disabled=false; $('btn-stop-bot').disabled=true; });

// chat user
function renderChatMessages(messages){ const h=$('chat-history'); h.innerHTML=''; (messages||[]).forEach(m=>appendChatLocal(m)); h.scrollTop = h.scrollHeight; }
function appendChatLocal(m){ const h=$('chat-history'); const el=document.createElement('div'); el.className='msg '+(m.from==='admin'?'admin':(m.from==='system'?'system':'user')); el.innerHTML=`<div class="meta"><strong>${m.from}</strong> <small>${new Date(m.time).toLocaleString()}</small></div><div class="text">${m.text}</div>`; h.appendChild(el); h.scrollTop=h.scrollHeight; }
$('chat-send').addEventListener('click', ()=>{ const text=$('chat-input').value.trim(); if(!text) return; socket.emit('send_chat',{token,text}); $('chat-input').value=''; });
$('chat-input').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('chat-send').click(); } });

// admin: users and actions including ban/unban and export
async function fetchAdminUsers(){ const res = await fetch('/api/admin/users', { headers:{ Authorization:'Bearer '+token } }); if(!res.ok) return; const arr = await res.json(); const tbody = document.querySelector('#admin-users tbody'); tbody.innerHTML=''; arr.forEach(u=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${u.username}</td><td>${u.balances.EUR||0}</td><td>${u.balances.BTC||0}</td><td>${u.balances.ETH||0}</td><td>${u.balances.USDT||0}</td><td>${u.balances.XRP||0}</td><td>${u.balances.LTC||0}</td><td><button class="adm-set" data-user="${u.username}">Set Balance</button> <button class="adm-ban" data-user="${u.username}">${u.banned?'Unban':'Ban'}</button> <button class="adm-export" data-user="${u.username}">Export CSV</button></td>`; tbody.appendChild(tr); }); document.querySelectorAll('.adm-set').forEach(btn=>btn.addEventListener('click', async ()=>{ const u=btn.dataset.user; const cur=prompt('Currency (EUR,BTC,ETH,USDT,XRP,LTC):','EUR'); if(!cur) return; const val=parseFloat(prompt('Amount for '+u+' '+cur+':','0')); if(isNaN(val)) return; const r = await fetch('/api/admin/set-balance',{ method:'POST', headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+token }, body: JSON.stringify({ username: u, currency: cur, amount: val }) }); if(r.ok) alert('Balance updated'); fetchAdminUsers(); })); document.querySelectorAll('.adm-ban').forEach(btn=>btn.addEventListener('click', async ()=>{ const u=btn.dataset.user; const action = btn.textContent.trim().toLowerCase(); const ban = action === 'ban'; const r = await fetch('/api/admin/ban', { method:'POST', headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+token }, body: JSON.stringify({ username: u, ban }) }); if(r.ok) alert('Updated'); fetchAdminUsers(); })); document.querySelectorAll('.adm-export').forEach(btn=>btn.addEventListener('click', ()=>{ const u=btn.dataset.user; downloadCSV(u); })); // update user list panel
  const ul = $('admin-userlist'); ul.innerHTML=''; arr.forEach(u=>{ const li=document.createElement('li'); li.textContent=u.username; li.dataset.user=u.username; li.addEventListener('click', ()=>{ adminActive=u.username; document.querySelectorAll('#admin-userlist li').forEach(n=>n.classList.remove('active')); li.classList.add('active'); loadAdminChat(u.username); }); ul.appendChild(li); }); }

let adminActive = null;
async function loadAdminChat(username){ const res = await fetch('/api/admin/chat/'+encodeURIComponent(username), { headers:{ Authorization:'Bearer '+token } }); if(!res.ok) return; const messages = await res.json(); renderAdminChat(messages, username); }
function renderAdminChat(messages, username){ adminActive = username; $('chat-with').textContent = 'Chat with ' + username; const h = $('admin-chat-history'); h.innerHTML=''; (messages||[]).forEach(m=>{ const el=document.createElement('div'); el.className='msg '+(m.from==='admin'?'admin':(m.from==='system'?'system':'user')); el.innerHTML=`<div class="meta"><strong>${m.from}</strong> <small>${new Date(m.time).toLocaleString()}</small></div><div class="text">${m.text}</div>`; h.appendChild(el); }); h.scrollTop = h.scrollHeight; }

$('admin-chat-send').addEventListener('click', ()=>{ if(!adminActive) return alert('Select a user'); const text = $('admin-chat-input').value.trim(); if(!text) return; socket.emit('admin_reply', { token, username: adminActive, text }); $('admin-chat-input').value=''; loadAdminChat(adminActive); });

$('admin-set-balance').addEventListener('click', async ()=>{ if(!adminActive) return alert('Select a user'); const cur = prompt('Currency (EUR,BTC,ETH,USDT,XRP,LTC):','EUR'); if(!cur) return; const val = parseFloat(prompt('Amount for '+adminActive+' '+cur+':','0')); if(isNaN(val)) return; const r = await fetch('/api/admin/set-balance',{ method:'POST', headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+token }, body: JSON.stringify({ username: adminActive, currency: cur, amount: val }) }); if(r.ok) alert('Balance updated'); loadAdminChat(adminActive); fetchAdminUsers(); });

// CSV download helper
async function downloadCSV(username){ // username optional for admin exporting specific user; if null and admin downloads all, omit query param
  let url = '/api/transactions/export';
  if(username) url += '?username=' + encodeURIComponent(username);
  const res = await fetch(url, { headers:{ Authorization:'Bearer '+token } });
  if(!res.ok) return alert('Export failed');
  const blob = await res.blob();
  const urlBlob = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = urlBlob; a.download = `transactions_${username||'all'}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(urlBlob);
}

// Admin incoming chat handler (brief)
function handleAdminIncomingChat(m){ // m: { user, from, text, time }
  // if currently viewing that user's chat, refresh it
  if(adminActive && m.user === adminActive) loadAdminChat(adminActive);
  // otherwise, optionally show a small notification (omitted for brevity)
}

// auto refresh admin list & user fetch every 2s
setInterval(()=>{ if(isAdmin) fetchAdminUsers(); if(!isAdmin && token) fetchMe(); }, 2000);

// initial connect if token present
if(token){ connectSocket(); setTimeout(()=>{ if(!socket) connectSocket(); }, 1000); }
