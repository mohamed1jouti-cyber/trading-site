// app.js - multi-currency trading simulator with chat and admin set-balance
const ADMIN_USER = 'admin';
const ADMIN_PASS = '12041998avril1999A';

// Utilities
const $ = id=>document.getElementById(id);
const fmt = (n,c='EUR')=>{ if(c==='EUR') return Number(n).toLocaleString(undefined,{style:'currency',currency:'EUR',maximumFractionDigits:2}); return Number(n).toLocaleString(); };
const nowISO = ()=>new Date().toISOString();

// Storage helpers
function loadUsers(){ return JSON.parse(localStorage.getItem('sim_users')||'{}'); }
function saveUsers(u){ localStorage.setItem('sim_users', JSON.stringify(u)); }
function getUser(username){ return loadUsers()[username]; }
function setUser(username, data){ const users = loadUsers(); users[username]=data; saveUsers(users); }

function loadChats(){ return JSON.parse(localStorage.getItem('sim_chats')||'{}'); }
function saveChats(c){ localStorage.setItem('sim_chats', JSON.stringify(c)); }
function getChat(username){ const c = loadChats(); return c[username] || []; }
function appendChat(username, msg){ const c = loadChats(); if(!c[username]) c[username]=[]; c[username].push(msg); saveChats(c); }

// Market state for multiple pairs
const PAIRS = {
  'BTC/EUR': {symbol:'BTC', base:'EUR', price:25000, vol:0.03},
  'ETH/EUR': {symbol:'ETH', base:'EUR', price:1500, vol:0.04},
  'USDT/EUR': {symbol:'USDT', base:'EUR', price:1, vol:0.001},
  'XRP/EUR': {symbol:'XRP', base:'EUR', price:0.5, vol:0.06},
  'LTC/EUR': {symbol:'LTC', base:'EUR', price:80, vol:0.05}
};

let priceSeriesStore = {}; // per pair
Object.keys(PAIRS).forEach(k=>priceSeriesStore[k]=[]);
let currentPair = 'BTC/EUR';
let price = PAIRS[currentPair].price;

// Views and auth
const views = { login:$('view-login'), register:$('view-register'), dashboard:$('view-dashboard'), admin:$('view-admin') };
let currentUser = null;
let adminActiveChat = null;

// Router
function showView(name){ Object.values(views).forEach(v=>v.classList.add('hidden')); views[name].classList.remove('hidden'); if(name==='dashboard') refreshDashboard(); if(name==='admin'){ renderAdmin(); renderAdminUserList(); renderAdminChat(); } }
$('nav-login').addEventListener('click', ()=>showView('login'));
$('nav-register').addEventListener('click', ()=>showView('register'));

// Auth
$('form-login').addEventListener('submit', e=>{ e.preventDefault(); const u=$('login-username').value.trim(), p=$('login-password').value; if(u===ADMIN_USER && p===ADMIN_PASS){ currentUser=ADMIN_USER; showView('admin'); return; } const user = getUser(u); if(!user || user.password!==p){ alert('Invalid username/password'); return; } currentUser=u; showView('dashboard'); });
$('form-register').addEventListener('submit', e=>{ e.preventDefault(); const u=$('register-username').value.trim(), p=$('register-password').value; if(!u||!p){ alert('Enter username and password'); return; } if(getUser(u)||u===ADMIN_USER){ alert('Username taken'); return; } const starter = {password:p, balances:{EUR:0,BTC:0,ETH:0,USDT:0,XRP:0,LTC:0}, history:[]}; setUser(u, starter); alert('Account created. You can now login.'); $('register-username').value=''; $('register-password').value=''; showView('login'); });
$('to-register').addEventListener('click', ()=>showView('register'));
$('to-login').addEventListener('click', ()=>showView('login'));
$('btn-logout').addEventListener('click', ()=>{ currentUser=null; showView('login'); });
$('admin-logout').addEventListener('click', ()=>{ currentUser=null; adminActiveChat=null; showView('login'); });

// Market simulation per-pair (realistic volatility)
function stepMarketFor(pair){ const pmeta = PAIRS[pair]; let series = priceSeriesStore[pair]; let last = series.length?series[series.length-1]:pmeta.price; // geometric random walk
  const shock = (Math.random()-0.5)*2 * pmeta.vol; const drift = (Math.random()-0.5)*0.001; let next = Math.max(0.0000001, last*(1+shock+drift)); series.push(next); if(series.length>300) series.shift(); priceSeriesStore[pair]=series; if(pair===currentPair) { price=next; drawPrice(); } }
function globalMarketStep(){ Object.keys(PAIRS).forEach(k=>stepMarketFor(k)); }
setInterval(globalMarketStep, 1000);

// Canvas draw for current pair
const canvas = $('price-canvas'); const ctx = canvas.getContext('2d');
function drawPrice(){ const series = priceSeriesStore[currentPair]; if(!series||series.length<2){ $('current-price').textContent = fmt(PAIRS[currentPair].price); return; } const w=canvas.width=canvas.clientWidth, h=canvas.height=200; ctx.clearRect(0,0,w,h); const max=Math.max(...series), min=Math.min(...series); ctx.beginPath(); series.forEach((p,i)=>{ const x=(i/(series.length-1))*w; const y=h - ((p-min)/(max-min||1))*h; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.strokeStyle='#7dd3fc'; ctx.lineWidth=2; ctx.stroke(); $('current-price').textContent = fmt(series[series.length-1]); price = series[series.length-1]; }

// Pair selector
$('pair-select').addEventListener('change', ()=>{ currentPair = $('pair-select').value; drawPrice(); refreshDashboard(); });

// Trading utilities (multi-currency)
// buy base (e.g., BTC) using EUR: reduce EUR, increase BTC
function buyBase(user, pair, amountBase){ const meta = PAIRS[pair]; const costEUR = amountBase * price; if(user.balances.EUR < costEUR) return false; user.balances.EUR -= costEUR; user.balances[meta.symbol] = (user.balances[meta.symbol]||0) + amountBase; user.history.push({type:'buy', pair, amountBase, price, date: nowISO()}); return true; }
// sell base for EUR
function sellBase(user, pair, amountBase){ const meta = PAIRS[pair]; if((user.balances[meta.symbol]||0) < amountBase) return false; user.balances[meta.symbol] -= amountBase; const proceeds = amountBase * price; user.balances.EUR = (user.balances.EUR||0) + proceeds; user.history.push({type:'sell', pair, amountBase, price, date: nowISO()}); return true; }

// Bot (per current pair)
let botInterval = null;
function sma(series, window){ if(window<=0) return []; const out=[]; for(let i=0;i<series.length;i++){ const start=Math.max(0,i-window+1); const slice=series.slice(start,i+1); out.push(slice.reduce((a,b)=>a+b,0)/slice.length); } return out; }
function startBot(){ if(botInterval) return; $('btn-start-bot').disabled=true; $('btn-stop-bot').disabled=false; const fastW = parseInt($('sma-fast').value,10)||5; const slowW = parseInt($('sma-slow').value,10)||20; const tradeSize = parseFloat($('trade-size').value)||1; botInterval = setInterval(()=>{ const series = priceSeriesStore[currentPair]||[]; const sFast = sma(series, fastW); const sSlow = sma(series, slowW); const i = series.length-1; if(i<1) return; const fast = sFast[i]||series[i]; const slow = sSlow[i]||series[i]; if(!currentUser) return; const user = getUser(currentUser); if(!user) return; if(fast > slow * 1.002){ // buy base
    const success = buyBase(user, currentPair, tradeSize); if(success){ appendChat(currentUser, {from:'system', text:`Bot BUY ${tradeSize} ${PAIRS[currentPair].symbol} @ ${fmt(price)}`, time: nowISO()}); } else { appendChat(currentUser, {from:'system', text:'Bot BUY skipped: insufficient EUR', time: nowISO()}); }
  } else if(fast < slow * 0.998){ // sell base
    const success = sellBase(user, currentPair, tradeSize); if(success){ appendChat(currentUser, {from:'system', text:`Bot SELL ${tradeSize} ${PAIRS[currentPair].symbol} @ ${fmt(price)}`, time: nowISO()}); } else { appendChat(currentUser, {from:'system', text:'Bot SELL skipped: insufficient base asset', time: nowISO()}); }
  } else { /* hold */ }
  setUser(currentUser, user); refreshDashboard(); }, 2500); }
function stopBot(){ if(!botInterval) return; clearInterval(botInterval); botInterval=null; $('btn-start-bot').disabled=false; $('btn-stop-bot').disabled=true; }
$('btn-start-bot').addEventListener('click', ()=>startBot()); $('btn-stop-bot').addEventListener('click', ()=>stopBot());

// Manual trades handlers
$('btn-buy').addEventListener('click', ()=>{ const amt = parseFloat($('manual-amount').value) || 0; if(amt<=0){ alert('Enter positive amount'); return; } const user = getUser(currentUser); if(!user) return; const ok = buyBase(user, currentPair, amt); if(!ok){ alert('Insufficient EUR'); return; } setUser(currentUser, user); refreshDashboard(); });
$('btn-sell').addEventListener('click', ()=>{ const amt = parseFloat($('manual-amount').value) || 0; if(amt<=0){ alert('Enter positive amount'); return; } const user = getUser(currentUser); if(!user) return; const ok = sellBase(user, currentPair, amt); if(!ok){ alert('Insufficient asset'); return; } setUser(currentUser, user); refreshDashboard(); });

// Render dashboard wallet and history
function refreshDashboard(){ if(!currentUser || currentUser===ADMIN_USER) return; const u = getUser(currentUser); $('welcome').textContent = `Welcome, ${currentUser}`; // wallet
  const wl = $('wallet-list'); wl.innerHTML=''; let totalEUR = 0; Object.keys(u.balances).forEach(k=>{ const tr = document.createElement('div'); tr.innerHTML = `<strong>${k}</strong>: ${u.balances[k]}`; wl.appendChild(tr); // convert to EUR for total
    if(k==='EUR') totalEUR += (u.balances[k]||0);
    else { const pair = `${k}/EUR`; const rate = (PAIRS[pair] && priceSeriesStore[pair] && priceSeriesStore[pair].length) ? priceSeriesStore[pair].slice(-1)[0] : (PAIRS[pair] ? PAIRS[pair].price : 0); totalEUR += (u.balances[k]||0) * rate; }
  }); $('total-eur').textContent = fmt(totalEUR); // history
  const hist = $('history'); hist.innerHTML=''; (u.history||[]).slice().reverse().forEach(h=>{ const d = new Date(h.date).toLocaleString(); const div = document.createElement('div'); if(h.type==='deposit' || h.type==='withdraw'){ div.textContent = `${d} — ${h.type.toUpperCase()} ${h.amount} ${h.currency||'EUR'}`; } else if(h.type==='buy' || h.type==='sell'){ div.textContent = `${d} — ${h.type.toUpperCase()} ${h.amountBase||h.amount} ${h.pair} @ ${fmt(h.price)}`; } else { div.textContent = `${d} — ${JSON.stringify(h)}`; } hist.appendChild(div); }); drawPrice(); renderUserChat(); }

// Chat - user side
function renderUserChat(){ const history = $('chat-history'); history.innerHTML=''; const msgs = getChat(currentUser); msgs.forEach(m=>{ const el = document.createElement('div'); el.className = 'msg ' + (m.from==='admin' ? 'admin' : (m.from==='system' ? 'system' : 'user')); el.innerHTML = `<div class="meta"><strong>${m.from}</strong> <small>${new Date(m.time).toLocaleString()}</small></div><div class="text">${m.text}</div>`; history.appendChild(el); }); history.scrollTop = history.scrollHeight; }
$('chat-send').addEventListener('click', ()=>{ const text = $('chat-input').value.trim(); if(!text) return; appendChat(currentUser, {from: currentUser, text, time: nowISO()}); $('chat-input').value=''; renderUserChat(); });
$('chat-input').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('chat-send').click(); } });

// Admin: user list and chat
function renderAdmin(){ const tbody = document.querySelector('#admin-users tbody'); tbody.innerHTML=''; const users = loadUsers(); Object.keys(users).forEach(u=>{ const data = users[u]; const tr = document.createElement('tr'); tr.innerHTML = `<td>${u}</td><td>${fmt(data.balances.EUR)}</td><td>${data.balances.BTC}</td><td>${data.balances.ETH}</td><td>${data.balances.USDT}</td><td>${data.balances.XRP}</td><td>${data.balances.LTC}</td><td><button class="adm-set" data-user="${u}">Set Balance</button></td>`; tbody.appendChild(tr); }); document.querySelectorAll('.adm-set').forEach(btn=>{ btn.addEventListener('click', ()=>{ const u = btn.dataset.user; const cur = prompt('Currency (EUR,BTC,ETH,USDT,XRP,LTC):','EUR'); if(!cur) return; const val = parseFloat(prompt('Amount for '+u+' '+cur+':','0')); if(isNaN(val)) return; const obj = getUser(u); obj.balances[cur] = val; obj.history = obj.history||[]; obj.history.push({type:'deposit', amount:val, currency:cur, date: nowISO(), by:'admin'}); setUser(u,obj); renderAdmin(); appendChat(u, {from:'admin', text:`Admin set your ${cur} balance to ${val}`, time: nowISO()}); if(currentUser===u) refreshDashboard(); }); }); }

function renderAdminUserList(){ const ul = $('admin-userlist'); ul.innerHTML=''; const users = loadUsers(); Object.keys(users).forEach(u=>{ const li = document.createElement('li'); li.textContent = u; li.dataset.user = u; li.addEventListener('click', ()=>{ adminActiveChat = u; document.querySelectorAll('#admin-userlist li').forEach(n=>n.classList.remove('active')); li.classList.add('active'); renderAdminChat(); }); ul.appendChild(li); }); }

function renderAdminChat(){ const title = $('chat-with'); const history = $('admin-chat-history'); history.innerHTML=''; if(!adminActiveChat){ title.textContent = 'Select a user'; return; } title.textContent = `Chat with ${adminActiveChat}`; const msgs = getChat(adminActiveChat); msgs.forEach(m=>{ const el = document.createElement('div'); el.className = 'msg ' + (m.from==='admin' ? 'admin' : (m.from==='system' ? 'system' : 'user')); el.innerHTML = `<div class="meta"><strong>${m.from}</strong> <small>${new Date(m.time).toLocaleString()}</small></div><div class="text">${m.text}</div>`; history.appendChild(el); }); history.scrollTop = history.scrollHeight; }

$('admin-chat-send').addEventListener('click', ()=>{ if(!adminActiveChat) return; const text = $('admin-chat-input').value.trim(); if(!text) return; appendChat(adminActiveChat, {from:'admin', text, time: nowISO()}); $('admin-chat-input').value=''; renderAdminChat(); });
$('admin-chat-input').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('admin-chat-send').click(); } });

// Admin Set Balance (also available via table)
$('admin-set-balance').addEventListener('click', ()=>{ if(!adminActiveChat) return alert('Select a user from the left'); const cur = prompt('Currency (EUR,BTC,ETH,USDT,XRP,LTC):','EUR'); if(!cur) return; const val = parseFloat(prompt('Amount for '+adminActiveChat+' '+cur+':','0')); if(isNaN(val)) return; const obj = getUser(adminActiveChat); obj.balances[cur] = val; obj.history = obj.history||[]; obj.history.push({type:'deposit', amount:val, currency:cur, date: nowISO(), by:'admin'}); setUser(adminActiveChat,obj); renderAdmin(); appendChat(adminActiveChat, {from:'admin', text:`Admin set your ${cur} balance to ${val}`, time: nowISO()}); renderAdminChat(); if(currentUser===adminActiveChat) refreshDashboard(); });

// Real-time polling for updates
setInterval(()=>{
  if(currentUser && currentUser!==ADMIN_USER){ renderUserChat(); refreshDashboard(); }
  if(currentUser===ADMIN_USER){ renderAdmin(); renderAdminUserList(); renderAdminChat(); }
}, 2000);

// Admin market single-step
$('admin-simulate').addEventListener('click', ()=>{ globalMarketStep(); drawPrice(); if(currentUser===ADMIN_USER){ renderAdmin(); renderAdminUserList(); renderAdminChat(); } });

// Seed if empty
(function seed(){
  const users = loadUsers();
  if(Object.keys(users).length===0){
    users['alice'] = {password:'alicepass', balances:{EUR:500, BTC:0.01, ETH:0, USDT:50, XRP:0, LTC:0}, history:[]};
    users['bob']   = {password:'bobpass', balances:{EUR:1200, BTC:0, ETH:0.2, USDT:0, XRP:1000, LTC:1}, history:[]};
    saveUsers(users);
  }
  const chats = loadChats();
  if(Object.keys(chats).length===0){
    chats['alice'] = [{from:'alice', text:'Hi admin — please send USDT deposit address.', time: nowISO()}];
    saveChats(chats);
  }
  // initialize some price history for each pair
  Object.keys(PAIRS).forEach(k=>{
    const meta = PAIRS[k];
    const arr = [];
    let p = meta.price;
    for(let i=0;i<60;i++){ p = Math.max(0.0001, p*(1 + (Math.random()-0.5)*meta.vol)); arr.push(p); }
    priceSeriesStore[k] = arr;
  });
})();

// Initial view
showView('login');
