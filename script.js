/* ==================== Firebase SDK ==================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc,
  serverTimestamp, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Session flag hygiene: clear manual sign-in flag on fresh navigations (not on reload)
try{
  const nav = performance.getEntriesByType('navigation')[0];
  const navType = nav && nav.type ? nav.type : (performance.navigation && performance.navigation.type===1? 'reload':'navigate');
  if(navType !== 'reload') sessionStorage.removeItem('manualSignInThisSession');
}catch{}
/* ==================== Firebase Config ==================== */
const firebaseConfig = {
  apiKey: "AIzaSyAaDiuQmFW2SA1HGQ1G8CH7YmYC1w104lY",
  authDomain: "apartment-management-v2.firebaseapp.com",
  projectId: "apartment-management-v2",
  storageBucket: "apartment-management-v2.firebasestorage.app",
  messagingSenderId: "614034681672",
  appId: "1:614034681672:web:0b7ad34ad970ea6178cd7d",
  measurementId: "G-973B4DLE2T"
};

/* ==================== Init ==================== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Ensure session-only persistence (logout when browser/Tab closes)
(async()=>{ try{ await setPersistence(auth, browserSessionPersistence); }catch(e){ console.error('setPersistence failed', e); } })();
const db = getFirestore(app);

/* ==================== Helpers ==================== */
const qs  = (s) => document.querySelector(s);
const qsa = (s) => Array.from(document.querySelectorAll(s));
const show = (el)=> el && el.classList.remove('hidden');
const hide = (el)=> el && el.classList.add('hidden');
const fmtTRY = new Intl.NumberFormat('tr-TR', { style:'currency', currency:'TRY' });
const fmtDate = (v)=> { if(!v) return "-"; const d=v instanceof Date?v:new Date(v); return d.toLocaleDateString('tr-TR',{year:'numeric',month:'short',day:'numeric'}); };

function setInputValue(form, selector, value){
  if(!form) return;
  const el = form.querySelector(selector);
  if (el) el.value = value ?? '';
}
function toISODateInput(v){
  if(!v) return '';
  const d = new Date(v);
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
}
function modalSel(...cands){ for(const s of cands){ if(qs(s)) return s; } return cands[0]; }

function statusToTR(s){
  if(!s) return '';
  const k = String(s).toLowerCase();
  if(k === 'owner' || k === 'ev sahibi' || k === 'evsahibi') return 'Ev Sahibi';
  if(k === 'tenant' || k === 'kiracı' || k === 'kiraci') return 'Kiracı';
  return s;
}
function statusToEN(s){
  if(!s) return '';
  const k = String(s).toLowerCase();
  if(k === 'owner' || k === 'ev sahibi' || k === 'evsahibi') return 'Owner';
  if(k === 'tenant' || k === 'kiracı' || k === 'kiraci') return 'Tenant';
  return s;
}
function setSelectSmart(selectEl, enVal){
  if(!selectEl) return;
  const trVal = statusToTR(enVal);
  const opts = Array.from(selectEl.options).map(o=>o.value);
  if(opts.includes(enVal)) selectEl.value = enVal;
  else if(opts.includes(trVal)) selectEl.value = trVal;
  else selectEl.value = '';
}
const typeToTR = (t)=> (t === 'Extra' ? 'Ek Ödeme' : 'Aidat');

/* ==================== State ==================== */
let currentUser = null;
let currentRole = "user";
let announcementsCache = [];
let editingAnnouncementId = null;
let editingRole = null;
let editingResidentId = null;
let editingPaymentId = null;
let editingExpenseId = null;

let _residentsCache = null;
async function getResidentsCached(){
  if(_residentsCache) return _residentsCache;
  _residentsCache = await listResidents();
  return _residentsCache;
}
function invalidateResidentsCache(){ _residentsCache = null; }

function isResidentActive(r){
  // Varsayılan: alan yoksa aktif kabul et.
  if (r.isActive === false) return false;
  if (r.moveOutDate) {
    try{
      const d = new Date(r.moveOutDate);
      if (!isNaN(d)) return d.getTime() > Date.now();
    }catch{}
    return false;
  }
  return true;
}

/* ======= Aidat (fees) state ======= */
let feesState = { ym: "", defaultAmount: 0, items: {} };
let assignFlatOnSave = null; // fees'den yeni sakin atarken kullanılır

/* ==================== Role Fetch ==================== */
async function fetchRole(uid){
  try{
    const snap = await getDoc(doc(db,'roles',uid));
    return snap.exists() && snap.data().role === 'admin';
  }catch(e){ console.error(e); return false; }
}


function enforceExportVisibility(){
  const isAdmin = (currentRole === 'admin');
  // IDs we know
  const ids = ['exportPayments','exportExpenses','payExportCSV','expExportCSV'];
  ids.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    if(isAdmin){
      el.style.display = '';
      el.removeAttribute('aria-disabled');
    }else{
      el.style.display = 'none';
      el.setAttribute('aria-disabled','true');
      el.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); return false; };
    }
  });
  // Generic text match fallback
  document.querySelectorAll('button, a').forEach(el=>{
    const text = (el.textContent || '').trim().toLowerCase();
    if(text === 'csv' || text === 'json' || text.includes('csv') || text.includes('json')){
      if(isAdmin){
        el.style.display='';
        el.removeAttribute('aria-disabled');
      }else{
        el.style.display='none';
        el.setAttribute('aria-disabled','true');
        el.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); return false; };
      }
    }
  });
}

/* ==================== Auth UI ==================== */
const loginForm  = qs('#loginForm');
const loginError = qs('#loginError');

loginForm?.addEventListener('submit', async (e)=>{ e.preventDefault(); loginError.textContent=""; try{
    window.__loginInProgress = true;
    const email = qs('#loginEmail').value.trim();
    const pass  = qs('#loginPassword').value;
    await signInWithEmailAndPassword(auth,email,pass);
    try{ sessionStorage.setItem('manualSignInThisSession','1'); }catch{};
    window.__loginInProgress = false;

  }catch(err){
    console.error(err); loginError.textContent = err?.message || "Giriş başarısız.";
  }
});
qs('#btnLogout')?.addEventListener('click', async ()=>{ try{ await signOut(auth); }catch(e){ console.error(e); }});


function trToAscii(str){
  const map = {'ç':'c','Ç':'C','ğ':'g','Ğ':'G','ı':'i','İ':'I','ö':'o','Ö':'O','ş':'s','Ş':'S','ü':'u','Ü':'U','₺':'TRY'};
  return String(str).replace(/[çÇğĞıİöÖşŞüÜ₺]/g, ch=>map[ch]||ch);
}

/* ==================== Reports (Yıllık Aidat Takip Cetveli + PDF) ==================== */
const MONTHS_TR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

function yearsOptionsHTML(span=9){
  const y0 = new Date().getFullYear();
  const start = y0 - Math.floor(span/2);
  return Array.from({length:span}, (_,i)=> start+i)
    .map(y=>`<option value="${y}" ${y===y0?'selected':''}>${y}</option>`).join('');
}

async function ensureReportsUI(){
  const ysel = qs('#repYear');
  if(ysel && !ysel.dataset.bound){
    ysel.innerHTML = yearsOptionsHTML(9);
    ysel.addEventListener('change', renderReportsTable);
    ysel.dataset.bound = '1';
  }
  const yselM = qs('#repMonthlyYear');
  if(yselM && !yselM.dataset.bound){
    yselM.innerHTML = yearsOptionsHTML(9);
    yselM.dataset.bound = '1';
  }
  // daire listesi
  try{
    const res = await getResidentsCached();
    const flats = Array.from(new Set(res.map(r=> String(r.flatNo||'').trim()).filter(Boolean)))
      .sort((a,b)=> (''+a).localeCompare(''+b, 'tr', {numeric:true}));
    const flatSel = qs('#repFlat');
    if(flatSel && !flatSel.dataset.filled){
      flatSel.innerHTML = `<option value="">Daire seçin</option>` + flats.map(f=>`<option>${f}</option>`).join('');
      flatSel.dataset.filled = '1';
    }
  }catch{}
  // butonlar
  qs('#repExportCSV')?.addEventListener('click', exportReportsCSV);
  qs('#repFlatPDF')?.addEventListener('click', generateFlatAnnualPDF);
  qs('#repMonthlyPDF')?.addEventListener('click', generateMonthlySummaryPDF);
  try{ enforceExportVisibility(); }catch{}
}

async function getYearFeesMap(year){
  const out = {}; // {flat: {'01': amount, ...}}
  const docs = await Promise.all(
    Array.from({length:12}, (_,i)=> getFeesDoc(`${year}-${String(i+1).padStart(2,'0')}`))
  );
  docs.forEach((fd, idx)=>{
    const mm = String(idx+1).padStart(2,'0');
    const def = +((fd&&fd.defaultAmount)||0);
    const items = (fd&&fd.items)||{};
    const flats = new Set(Object.keys(items));
    Object.keys(out).forEach(f=>flats.add(f));
    flats.forEach(f=>{
      if(!out[f]) out[f] = {};
      const amt = items[f]!=null ? +items[f] : def;
      out[f][mm] = +amt || 0;
    });
  });
  return out;
}

function collectFlatsFromResidentsAndFees(residents, feesMap){
  const set = new Set();
  (residents||[]).forEach(r=>{ const f=String(r.flatNo||'').trim(); if(f) set.add(f); });
  Object.keys(feesMap||{}).forEach(f=> set.add(f));
  return Array.from(set).sort((a,b)=> (''+a).localeCompare(''+b, 'tr', {numeric:true}));
}


function buildPaymentsIndex(payments){
  // Aidat (Due) ödemelerini ay bazında indeksler: idx[flat][YYYY-MM] = toplam
  const idx = {};
  (payments||[]).forEach(p=>{
    const type = p.type || p.paymentType || 'Due';
    if(type !== 'Due') return;
    const ym = paymentPeriod(p); if(!/^\d{4}-\d{2}$/.test(ym)) return;
    const flat = String(p.flatNo || p._derivedFlatNo || '').trim(); if(!flat) return;
    const amount = +p.amount || 0;
    if(!idx[flat]) idx[flat]={};
    idx[flat][ym] = (idx[flat][ym]||0) + amount;
  });
  return idx;
}

function buildExtrasIndex(payments){
  // Ek ödemeleri, ÖDEME TARİHİNE göre ay bazında indeksler: idx[flat][YYYY-MM] = toplam
  const idx = {};
  (payments||[]).forEach(p=>{
    const type = p.type || p.paymentType || 'Due';
    if(type !== 'Extra') return;
    const dt = p.date ? new Date(p.date) : null;
    if(!dt || isNaN(dt)) return;
    const ym = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0');
    const flat = String(p.flatNo || p._derivedFlatNo || '').trim(); if(!flat) return;
    const amount = +p.amount || 0;
    if(!idx[flat]) idx[flat]={};
    idx[flat][ym] = (idx[flat][ym]||0) + amount;
  });
  return idx;
}



async function renderReportsTable(){
  const year = qs('#repYear')?.value || String(new Date().getFullYear());
  const thead = qs('#repThead'); const tbody = qs('#repTbody'); const tfoot = qs('#repTfoot');
  if(!thead||!tbody||!tfoot) return;

  const [residents, payments] = await Promise.all([getResidentsCached(), listPayments()]);

  // Daire numarasını mümkün olduğunca tutarlı üret
  const idToFlat   = new Map(residents.map(r=>[r.id, String(r.flatNo||'')]));
  const nameToFlat = new Map(residents.filter(r=>r.fullName).map(r=>[String(r.fullName).trim().toLowerCase(), String(r.flatNo||'')]));
  payments.forEach(p=>{
    if(!p._derivedFlatNo){
      if(p.flatNo!=null && String(p.flatNo).trim()!=='') p._derivedFlatNo = String(p.flatNo);
      else if(p.residentId && idToFlat.get(p.residentId)) p._derivedFlatNo = idToFlat.get(p.residentId);
      else if(p.residentName){
        const f2 = nameToFlat.get(String(p.residentName).trim().toLowerCase());
        if(f2) p._derivedFlatNo = f2;
      }
    }
  });

  const feesMap = await getYearFeesMap(year);
  const flats   = collectFlatsFromResidentsAndFees(residents, feesMap);

  // Sadece AİDAT ödemeleri (type='Due')
  const payIdx  = buildPaymentsIndex(payments);

  thead.innerHTML = `
    <tr>
      <th>Daire</th>
      ${MONTHS_TR.map(m=>`<th>${m}</th>`).join('')}
      <th>Aidat Borç</th>
      <th>Aidat Ödeme</th>
      <th>Kalan</th>
    </tr>`;

  let sumDueAll=0, sumPaidAll=0;
  const rowsHTML = flats.map(f=>{
    let rowDue=0, rowPaid=0;
    const tds = MONTHS_TR.map((_,i)=>{
      const mm = String(i+1).padStart(2,'0');
      const due = ((feesMap[f]||{})[mm])||0;
      const paid = (payIdx[f] && payIdx[f][`${year}-${mm}`]) || 0;
      rowDue += due; rowPaid += paid;
      return `<td class="num">${format(due)}</td>`;
    }).join('');

    sumDueAll += rowDue; sumPaidAll += rowPaid;
    const remain = rowDue - rowPaid;
    const st = remain<=0 ? `<span class="badge ok">Tam</span>` : `<span class="badge warn">Eksik</span>`;
    return `
      <tr>
        <td><b>${escapeHtml(f)}</b></td>
        ${tds}
        <td class="num"><b>${format(rowDue)}</b></td>
        <td class="num"><b>${format(rowPaid)}</b></td>
        <td class="num"><b>${format(remain)}</b> ${st}</td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rowsHTML || `<tr><td colspan="${1+MONTHS_TR.length+3}" class="muted">Kayıt bulunamadı.</td></tr>`;

  const diffAll = sumDueAll - sumPaidAll;
  tfoot.innerHTML = `
    <tr>
      <td><b>TOPLAM</b></td>
      ${MONTHS_TR.map(()=>`<td></td>`).join('')}
      <td class="num"><b>${format(sumDueAll)}</b></td>
      <td class="num"><b>${format(sumPaidAll)}</b></td>
      <td class="num"><b>${format(diffAll)}</b></td>
    </tr>`;

  try{ enforceExportVisibility(); }catch{}
}

/* ==================== Ek Ödeme Raporu (Sadece Ek Ödeme Tablosu) ==================== */
async function renderExtraReportTable(){
  const ysel = qs('#extraRepYear');
  const fsel = qs('#extraRepFee');
  const tbody = qs('#extraRepTbody');
  if(!ysel||!tbody) return;

  const year = ysel.value || String(new Date().getFullYear());
  const cfg = await getExtraPaymentForYear(year);
  const amount = +((cfg&&cfg.amount)||0);
  const title = (cfg&&cfg.title)||'Yıllık Ek Ödeme';

  // Fee selector (tek kalem - yıllık)
  if(fsel){
    fsel.innerHTML = `<option value="YEARLY">${escapeHtml(title)} (${year})</option>`;
    fsel.value = 'YEARLY';
  }

  const [residents, payments] = await Promise.all([getResidentsCached(), listPayments()]);
  const feesMap = await getYearFeesMap(year);
  const flats   = collectFlatsFromResidentsAndFees(residents, feesMap);

  // Ek ödeme ödemeleri: type='Extra' ve yıl eşleşenler
  const extraPaidByFlat = {};
  payments.forEach(p=>{
    if(String(p.type||'')!=='Extra') return;
    const d = p.date ? String(p.date) : '';
    if(!d.startsWith(String(year)+'-')) return;
    const flat = String(p._derivedFlatNo || p.flatNo || '').trim();
    if(!flat) return;
    extraPaidByFlat[flat] = (extraPaidByFlat[flat]||0) + (+p.amount||0);
  });

  tbody.innerHTML = flats.map(f=>{
    const due = amount;
    const paid = extraPaidByFlat[f]||0;
    const rem = due - paid;
    const st = rem<=0 ? `<span class="badge ok">Tam</span>` : (paid>0 ? `<span class="badge warn">Kısmi</span>` : `<span class="badge bad">Ödenmedi</span>`);
    return `<tr>
      <td><b>${escapeHtml(f)}</b></td>
      <td class="num">${format(due)}</td>
      <td class="num">${format(paid)}</td>
      <td class="num"><b>${format(rem)}</b></td>
      <td>${st}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">Kayıt bulunamadı.</td></tr>`;
}

function ensureExtraReportYears(){
  const ysel = qs('#extraRepYear');
  if(!ysel || ysel.dataset.bound) return;
  ysel.dataset.bound = '1';
  ysel.innerHTML = yearsOptionsHTML(9);
  ysel.value = String(new Date().getFullYear());
  ysel.addEventListener('change', ()=>renderExtraReportTable());
  qs('#extraRepFee')?.addEventListener('change', ()=>renderExtraReportTable());
  qs('#extraRepExportCSV')?.addEventListener('click', ()=>exportExtraReportCSV());
}

function exportExtraReportCSV(){
  const tbody = qs('#extraRepTbody');
  const year = qs('#extraRepYear')?.value || '';
  const title = qs('#extraRepFee')?.selectedOptions?.[0]?.textContent || 'Ek Ödeme';
  if(!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr')).map(tr=>Array.from(tr.children).map(td=>td.textContent.trim()));
  const header = ['Daire','Borç','Ödenen','Kalan','Durum'];
  const csv = [header, ...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadText(`ek_odeme_raporu_${year}.csv`, csv, 'text/csv;charset=utf-8');
}

/* ensure reports page binds extra report */


function exportReportsCSV(){
  if(currentRole!=='admin') return;
  const table = qs('#repTbl'); if(!table) return;
  const rows = Array.from(table.querySelectorAll('tr')).map(tr=> Array.from(tr.children).map(td=> trToAscii(td.innerText.trim())));
  const sep=','; const bom='\ufeff';
  const csv = ['sep=,', ...rows.map(r=> r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(sep))].join('\n');
  const blob = new Blob([bom+csv], {type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  const y = qs('#repYear')?.value || new Date().getFullYear();
  a.download = `aidat-raporu-${y}.csv`; a.click();
}


async function generateFlatAnnualPDF(){
  if(currentRole!=='admin') return;
  const flat = qs('#repFlat')?.value;
  const year = qs('#repYear')?.value || String(new Date().getFullYear());
  if(!flat){ alert('Daire seçin'); return; }

  const [residents, payments] = await Promise.all([getResidentsCached(), listPayments()]);
  const nameToFlat = new Map(residents.map(r=>[(r.name||'').trim().toLowerCase(), String(r.flatNo||'')]));
  payments.forEach(p=>{ if(!p.flatNo && p.residentName){ const f = nameToFlat.get(p.residentName.trim().toLowerCase()); if(f) p._derivedFlatNo = f; } });

  const feesMap = await getYearFeesMap(year);
  const payIdx  = buildPaymentsIndex(payments);

  let totalDue=0, totalPaid=0;

  const body = [
    ['Ay','Borç (₺)','Ödeme (₺)','Kalan (₺)','Durum'].map(h=>({text:h,bold:true}))
  ];

  for(let i=1;i<=12;i++){
    const mm = String(i).padStart(2,'0');
    const due = ((feesMap[flat]||{})[mm])||0;
    const paid = (payIdx[flat] && payIdx[flat][`${year}-${mm}`]) || 0;
    const rem = Math.max(0, due - paid);

    totalDue += due; totalPaid += paid;

    // Durum rozeti (aidat bazlı)
    let label='x';
    if(due===0 && paid===0) label='-';
    else if(paid>=due && due>0) label='✓';
    else if(paid>0 && paid<due) label='o';

    let fill='#fee2e2', fontC='#991b1b';
    if(label==='✓'){ fill='#dcfce7'; fontC='#166534'; }
    else if(label==='o'){ fill='#fef9c3'; fontC='#854d0e'; }
    else if(label==='-'){ fill='#f1f5f9'; fontC='#475569'; }

    body.push([
      MONTHS_TR[i-1],
      fmtTRY.format(due),
      fmtTRY.format(paid),
      fmtTRY.format(rem),
      {text:label, alignment:'center', fillColor: fill, color: fontC, bold:true}
    ]);
  }

  const dd = {
    content: [
      {text:`Yıllık Aidat Cetveli — Daire ${flat} — ${year}`, style:'header'},
      {table:{widths:['*','*','*','*',40], body}, layout:'lightHorizontalLines', margin:[0,10,0,10]},
      {text:`Toplam Aidat Borç: ${fmtTRY.format(totalDue)}    Toplam Aidat Ödeme: ${fmtTRY.format(totalPaid)}    Kalan: ${fmtTRY.format(Math.max(0,totalDue-totalPaid))}`, margin:[0,6,0,0]}
    ],
    defaultStyle:{ font:'Roboto' },
    styles:{ header:{fontSize:14,bold:true,margin:[0,0,0,8]} }
  };

  if(window.pdfMake && window.pdfMake.createPdf){
    window.pdfMake.createPdf(dd).download(`Daire-${flat}-${year}.pdf`);
  }else{
    alert('PDF motoru (pdfmake) yüklenemedi.');
  }
}




async function generateMonthlySummaryPDF(){
  if(currentRole!=='admin') return;
  const year = qs('#repMonthlyYear')?.value || qs('#repYear')?.value || String(new Date().getFullYear());
  const month = qs('#repMonthlyMonth')?.value || String(new Date().getMonth()+1).padStart(2,'0');
  const ym = `${year}-${month}`;

  const [residents, payments] = await Promise.all([getResidentsCached(), listPayments()]);
  const nameToFlat = new Map(residents.map(r=>[(r.name||'').trim().toLowerCase(), String(r.flatNo||'')]));
  payments.forEach(r=>{
    if(!r.flatNo && r.residentName){
      const f = nameToFlat.get(r.residentName.trim().toLowerCase());
      if(f) r._derivedFlatNo = f;
    }
  });

  const fdoc = await getFeesDoc(ym);
  const defaultAmount = +((fdoc&&fdoc.defaultAmount)||0);
  const items = (fdoc&&fdoc.items)||{};

  const flats = Array.from(new Set([
    ...residents.map(r=> String(r.flatNo||'').trim()).filter(Boolean),
    ...Object.keys(items)
  ])).sort((a,b)=> (''+a).localeCompare(''+b,'tr',{numeric:true}));

  const payIdx  = buildPaymentsIndex(payments);
  const extraIdx= buildExtrasIndex(payments);
  const rows = flats.map(f=>{
    const due = (items[f]!=null) ? +items[f] : defaultAmount;
    const paid = (payIdx[f] && payIdx[f][ym]) || 0;
    const extra= (extraIdx[f] && extraIdx[f][ym]) || 0;
    return { flat:f, due, paid, extra, diff: paid - due };
  });

  const body = [
    [{text:'Daire',bold:true},{text:'Aidat (₺)',bold:true},{text:'Ödenen (₺)',bold:true},{text:'Ek (₺)',bold:true},{text:'Fark',bold:true}],
    ...rows.map(r=>[ String(r.flat), fmtTRY.format(r.due), fmtTRY.format(r.paid), fmtTRY.format(r.extra), fmtTRY.format(r.diff) ])
  ];
  const sumDue = rows.reduce((s,r)=>s+r.due,0);
  const sumPaid= rows.reduce((s,r)=>s+r.paid,0);
  const sumExtra=rows.reduce((s,r)=>s+r.extra,0);

  const dd = {
    content:[
      {text:`Aylık İcmal — ${MONTHS_TR[+month-1]} ${year}`, style:'header'},
      {table:{widths:['auto','*','*','*','*'], body}, layout:'lightHorizontalLines', margin:[0,10,0,10]},
      {text:`Toplam Aidat: ${fmtTRY.format(sumDue)}    Toplam Ödeme: ${fmtTRY.format(sumPaid)}    Toplam Ek: ${fmtTRY.format(sumExtra)}    Fark: ${fmtTRY.format(sumPaid-sumDue)}`}
    ],
    defaultStyle:{font:'Roboto'},
    styles:{ header:{fontSize:14,bold:true,margin:[0,0,0,8]} }
  };
  if(window.pdfMake && window.pdfMake.createPdf){
    window.pdfMake.createPdf(dd).download(`Aylik-Icmal-${ym}.pdf`);
  }else{
    alert('PDF motoru (pdfmake) yüklenemedi.');
  }
}



/* ==================== Navigation ==================== */
const pages = ['dashboard','residents','payments','expenses','reports','fees'];
function showPage(id){
  try{ enforceExportVisibility(); }catch(e){}
  pages.forEach(p=>{ const el=qs('#'+p); if(!el) return; p===id?show(el):hide(el); });
  qsa('.nav .nav-btn').forEach(b=>b.classList.remove('active'));
  const map={dashboard:'#btnDashboard',residents:'#btnResidents',payments:'#btnPayments',expenses:'#btnExpenses',reports:'#btnReports',fees:'#btnFees'};
  qs(map[id])?.classList.add('active');
}
qs('#btnDashboard')?.addEventListener('click',()=>showPage('dashboard'));
qs('#btnResidents')?.addEventListener('click',async ()=>{ showPage('residents'); await renderResidentsTable(); });
qs('#btnPayments')?.addEventListener('click',async ()=>{ showPage('payments'); await ensurePaymentsUI(); await renderPaymentsTable(); });
qs('#btnExpenses')?.addEventListener('click',async ()=>{ showPage('expenses'); await ensureExpensesUI(); await renderExpensesTable(); });
qs('#btnReports')?.addEventListener('click',async ()=>{ showPage('reports'); await (ensureReportsUI?.()||Promise.resolve()); await (renderReportsTable?.()||Promise.resolve()); try{ ensureExtraReportYears(); await renderExtraReportTable(); }catch(e){ console.error(e);} });
qs('#btnFees')?.addEventListener('click',async ()=>{ showPage('fees'); await ensureFeesUI(); await renderFeesTable(); });

/* ==================== Firestore wrappers ==================== */
async function listResidents(){ const s=await getDocs(collection(db,'residents')); return s.docs.map(d=>({id:d.id,...d.data()})); }
async function addResident(data){ if(currentRole!=='admin') throw new Error('Yetki yok'); const res = await addDoc(collection(db,'residents'),{...data,createdAt:serverTimestamp(),createdBy:currentUser?.uid||null}); invalidateResidentsCache(); return res; }
async function updateResident(id, data){ if(currentRole!=='admin') throw new Error('Yetki yok'); const r = await updateDoc(doc(db,'residents',id), data); invalidateResidentsCache(); return r; }
async function deleteResident(id){ if(currentRole!=='admin') throw new Error('Yetki yok'); const r = await deleteDoc(doc(db,'residents',id)); invalidateResidentsCache(); return r; }

async function listPayments(){ const s=await getDocs(collection(db,'payments')); return s.docs.map(d=>({id:d.id,...d.data()})); }
async function addPayment(data){ if(currentRole!=='admin') throw new Error('Yetki yok'); return addDoc(collection(db,'payments'),{...data,createdAt:serverTimestamp(),createdBy:currentUser?.uid||null}); }
async function updatePayment(id, data){ if(currentRole!=='admin') throw new Error('Yetki yok'); return updateDoc(doc(db,'payments',id), data); }
async function deletePayment(id){ if(currentRole!=='admin') throw new Error('Yetki yok'); return deleteDoc(doc(db,'payments',id)); }

async function listExpenses(){ const s=await getDocs(collection(db,'expenses')); return s.docs.map(d=>({id:d.id,...d.data()})); }
async function addExpense(data){ if(currentRole!=='admin') throw new Error('Yetki yok'); return addDoc(collection(db,'expenses'),{...data,createdAt:serverTimestamp(),createdBy:currentUser?.uid||null}); }
async function updateExpense(id, data){ if(currentRole!=='admin') throw new Error('Yetki yok'); return updateDoc(doc(db,'expenses',id), data); }
async function deleteExpense(id){ if(currentRole!=='admin') throw new Error('Yetki yok'); return deleteDoc(doc(db,'expenses',id)); }

async function listAnnouncements(){ const s=await getDocs(collection(db,'announcements')); return s.docs.map(d=>({id:d.id,...d.data()})); }
async function addAnnouncement(data){ if(currentRole!=='admin') throw new Error('Yetki yok'); return addDoc(collection(db,'announcements'),{...data,createdAt:serverTimestamp(),createdBy:currentUser?.uid||null}); }
async function updateAnnouncement(id,data){ if(currentRole!=='admin') throw new Error('Yetki yok'); return updateDoc(doc(db,'announcements',id),data); }
async function deleteAnnouncement(id){ if(currentRole!=='admin') throw new Error('Yetki yok'); return deleteDoc(doc(db,'announcements',id)); }

/* ===== Fees (Aidat) ===== */
async function getFeesDoc(ym){ const r=doc(db,'fees',ym); const s=await getDoc(r); return s.exists()?{id:ym,...s.data()}:null; }
async function setFeesDoc(ym,data){ if(currentRole!=='admin') throw new Error('Yetki yok'); const r=doc(db,'fees',ym); return setDoc(r,{ym, ...data, updatedAt:serverTimestamp(),updatedBy:currentUser?.uid||null}); }

/* ===== Extra Payments (Yıllık Ek Ödeme) ===== */
async function getExtraPaymentDoc(year){
  const id = String(year);
  const r = doc(db,'extraPayments', id);
  const s = await getDoc(r);
  return s.exists() ? { id, ...s.data() } : null;
}
async function setExtraPaymentDoc(year, data){
  if(currentRole!=='admin') throw new Error('Yetki yok');
  const id = String(year);
  await setDoc(
    doc(db,'extraPayments', id),
    { year: Number(year), ...data, updatedAt: serverTimestamp(), updatedBy: currentUser?.uid || null },
    { merge: true }
  );
}
async function getExtraPaymentForYear(year){
  // returns {amount,title,description} or null
  try{ return await getExtraPaymentDoc(year); }catch(e){ console.warn('extraPayments read failed', e); return null; }
}

/* ===== Admin Info ===== */
async function getAdminInfoDoc(){ const r=doc(db,'settings','adminInfo'); const s=await getDoc(r); return s.exists()?s.data():{}; }
async function setAdminInfoDoc(data){ if(currentRole!=='admin') throw new Error('Yetki yok'); const r=doc(db,'settings','adminInfo'); return setDoc(r,{...data,updatedAt:serverTimestamp(),updatedBy:currentUser?.uid||null},{merge:true}); }

/* ==================== İlk Kurulum: adminInfo yoksa oluştur ==================== */
async function ensureAdminInfoDoc(){
  try{
    const ref = doc(db,'settings','adminInfo');
    const snap = await getDoc(ref);
    if(snap.exists()) return;
    if(currentRole!=='admin') return;
    const defaultInfo = {
      adminName: "", adminPhone: "",
      assistantName: "", assistantPhone: "",
      supervisorName: "", supervisorPhone: "",
      createdAt: new Date().toISOString()
    };
    await setDoc(ref, defaultInfo, { merge:true });
  }catch(e){ console.error("ensureAdminInfoDoc:", e); }
}

/* ==================== Export helpers ==================== */
async function exportCollection(name){
  const s=await getDocs(collection(db,name));
  const data=s.docs.map(d=>({id:d.id,...d.data()}));
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`${name}-${new Date().toISOString().slice(0,10)}.json`; a.click();
}
qs('#exportPayments')?.addEventListener('click',()=>exportCollection('payments'));
qs('#exportExpenses')?.addEventListener('click',()=>exportCollection('expenses'));

/* ==================== Dashboard summary ==================== */
async function renderDashboard(){
  const box=qs('#dashboardSummary'); if(!box) return; box.innerHTML="";
  const [res,pays,exps]=await Promise.all([listResidents(),listPayments(),listExpenses()]);
  // ✅ Dashboard 'Toplam Sakin' sadece aktif sakinleri içerir
  const activeRes = (res||[]).filter(isResidentActive);
  // ✅ Dashboard 'Toplam Sakin' sadece aktif sakinleri içerir
  const activeRes = (res||[]).filter(isResidentActive);
  const totalP=pays.reduce((s,p)=>s+(+p.amount||0),0);
  const totalE=exps.reduce((s,p)=>s+(+p.amount||0),0);
  const items=[
    {title:'Toplam Sakin', val: activeRes.length},
    {title:'Toplam Ödeme', val: fmtTRY.format(totalP)},
    {title:'Toplam Gider',  val: fmtTRY.format(totalE)},
    {title:'Bakiye',       val: fmtTRY.format(totalP-totalE)}
  ];
  items.forEach(c=>{ const d=document.createElement('div'); d.className='card'; d.innerHTML=`<h3>${c.title}</h3><p style="font-size:24px;margin:8px 0 0">${c.val}</p>`; box.appendChild(d); });
}

/* ==================== Announcements ==================== */
async function renderAnnouncements(){
  const box=qs('#announcementList'); if(!box) return;
  const rows=await listAnnouncements(); announcementsCache = rows;
  box.innerHTML = rows.map(r=>{
    const t=r.type||'info';
    const created=r.createdAt?.toDate?r.createdAt.toDate():(r.createdAt||r.date);
    const when=created?fmtDate(created):'';
    const actions = currentRole==='admin'
      ? `<div class="ann-actions">
           <button type="button" class="btn small edit" data-id="${r.id}">✏️ Düzenle</button>
           <button type="button" class="btn small danger delete" data-id="${r.id}">🗑️ Sil</button>
         </div>` : '';
    return `<div class="ann-card ${t}" data-id="${r.id}">
      <div class="ann-top"><div class="ann-title">${r.title||'-'}</div><div class="ann-date meta">${when}</div></div>
      <div class="ann-body">${r.content||'-'}</div>${actions}</div>`;
  }).join('') || '<div class="neutral"><div><strong>Henüz duyuru yok</strong></div></div>';

  box.onclick = async (e)=>{
  const edit = e.target.closest('.edit');
  const del  = e.target.closest('.delete');
  if(edit){
    const id = edit.dataset.id;
    const s  = announcementsCache.find(a=>a.id===id); if(!s) return;
    const f  = qs('#formAnnouncement');
    if(!f){ alert('Duyuru formu bulunamadı'); return; }
    f.title.value   = s.title||'';
    f.type.value    = s.type||'info';
    f.content.value = s.content||'';
    editingAnnouncementId = id;
    openModal(modalSel('#modalAnnouncement','#announcementModal'));
    return;
  }
  if(del){
    const id = del.dataset.id;
    if(!confirm('Bu duyuruyu silmek istiyor musunuz?')) return;
    await deleteAnnouncement(id);
    await renderAnnouncements();
    return;
  }
};
}

/* --- Admin Info (view) --- */
async function renderAdminInfo(){
  const data = await getAdminInfoDoc();
  const set=(id,val)=>{ const el=qs('#'+id); if(el) el.textContent=(val&&String(val).trim())||'Not Set'; };
  set('adminNameText', data.adminName);
  set('adminPhoneText', data.adminPhone);
  set('assistantNameText', data.assistantName);
  set('assistantPhoneText', data.assistantPhone);
  set('supervisorNameText', data.supervisorName);
  set('supervisorPhoneText', data.supervisorPhone);
}

/* Saat/Tarih */
function tickClockTR(){
  const d=qs('#currentDateTR'), t=qs('#currentTimeTR'); if(!d||!t) return;
  const now=new Date();
  d.textContent = now.toLocaleDateString('tr-TR',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  t.textContent = now.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
setInterval(tickClockTR, 1000); tickClockTR();

/* Role-bazlı admin info modal açıcı */
function openAdminInfoForRole(role){
  editingRole = role || 'all';
  const titleMap={admin:'Yönetici Bilgilerini Düzenle',assistant:'Yönetici Yardımcısı Bilgilerini Düzenle',supervisor:'Denetmen Bilgilerini Düzenle',all:'Yönetici Bilgilerini Düzenle'};
  const setRow=(id,on)=>{ const el=qs(id); if(el) on?show(el):hide(el); };
  if(role==='admin'){ setRow('#rowAdmin',true); setRow('#rowAssistant',false); setRow('#rowSupervisor',false); }
  else if(role==='assistant'){ setRow('#rowAdmin',false); setRow('#rowAssistant',true); setRow('#rowSupervisor',false); }
  else if(role==='supervisor'){ setRow('#rowAdmin',false); setRow('#rowAssistant',false); setRow('#rowSupervisor',true); }
  else { setRow('#rowAdmin',true); setRow('#rowAssistant',true); setRow('#rowSupervisor',true); }
  qs('#adminInfoModalTitle') && (qs('#adminInfoModalTitle').textContent = titleMap[editingRole] || titleMap.all);

  getAdminInfoDoc().then(data=>{
    const setVal=(name,val)=>{ const el=qs(`[name="${name}"]`); if(el) el.value=val||''; };
    setVal('adminName', data.adminName); setVal('adminPhone', data.adminPhone);
    setVal('assistantName', data.assistantName); setVal('assistantPhone', data.assistantPhone);
    setVal('supervisorName', data.supervisorName); setVal('supervisorPhone', data.supervisorPhone);
  });

  openModal(modalSel('#modalAdminInfo','#adminInfoModal'));
}
qsa('.role-edit').forEach(btn=>{
  btn.addEventListener('click',(e)=>{
    e.preventDefault(); if(currentRole!=='admin') return;
    openAdminInfoForRole(btn.dataset.role);
  });
});

/* ==================== Residents ==================== */
async function renderResidentsTable(){
  const tbody = qs('#resTbody'); if(!tbody) return;

  // Filtre (Aktif / Pasif / Tümü)
  const filterSel = qs('#resFilter');
  const filterVal = (filterSel?.value || 'active');

  // Filtre değişince tekrar çiz
  if(filterSel && !filterSel.dataset.bound){
    filterSel.addEventListener('change', ()=> renderResidentsTable());
    filterSel.dataset.bound = '1';
  }

  let rows = await listResidents();
  rows.sort((a,b)=> (''+(a.flatNo||'')).localeCompare((''+(b.flatNo||'')), 'tr', {numeric:true}));

  // aktif/pasif filtre uygula
  rows = rows.filter(r=>{
    if(filterVal==='all') return true;
    const active = isResidentActive(r);
    if(filterVal==='active') return active;
    if(filterVal==='passive') return !active;
    return true;
  });

  const isAdminUI = currentRole==='admin';
  tbody.innerHTML = rows.map(r=>{
    const active = isResidentActive(r);
    const activeBadge = active
      ? '<span class="badge paid">Aktif</span>'
      : '<span class="badge unpaid">Pasif</span>';

    const toggleBtn = isAdminUI
      ? `<button type="button" class="btn small outline" data-toggle="${r.id}" data-to="${active ? 'passive' : 'active'}">
           ${active ? '⛔ Pasife Al' : '✅ Aktife Al'}
         </button>`
      : '';

    return `
    <tr data-id="${r.id}">
      <td>${r.flatNo||''}</td>
      <td>${r.name||''}</td>
      <td>${r.phone||''}</td>
      <td>${r.email||''}</td>
      <td>${statusToTR(r.status)}</td>
      <td>${r.licensePlate||''}</td>
      <td>${activeBadge}</td>
      <td>
        ${isAdminUI ? `
          <button type="button" class="btn small" data-edit="${r.id}">✏️ Düzenle</button>
          ${toggleBtn}
          <button type="button" class="btn small danger" data-del="${r.id}">🗑️ Sil</button>
        ` : ''}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;color:#777;padding:16px">Henüz kayıt yok</td></tr>`;

  if (!tbody.dataset.bound) {
    tbody.addEventListener('click', onResidentsTableClick);
    tbody.dataset.bound = '1';
  }
}


async function setResidentActive(residentId, makeActive){
  const list = await listResidents();
  const rec = list.find(x=>x.id===residentId);
  if(!rec) return;

  const nowISO = new Date().toISOString();

  if(makeActive){
    // Bu dairede başka aktif varsa pasife al
    const flatNo = String(rec.flatNo||'').trim();
    if(flatNo){
      await deactivateActiveResidentsForFlat(flatNo, residentId, nowISO);
    }
    await updateResident(residentId, { isActive:true, moveOutDate:null });
  }else{
    await updateResident(residentId, { isActive:false, moveOutDate: nowISO });
  }
}
async function onResidentsTableClick(e){
  const editBtn   = e.target.closest('button[data-edit]');
  const delBtn    = e.target.closest('button[data-del]');
  const toggleBtn = e.target.closest('button[data-toggle]');

  if(!editBtn && !delBtn && !toggleBtn) return;
  e.preventDefault(); e.stopPropagation();

  if(currentRole!=='admin'){ alert('Sadece yönetici işlem yapabilir.'); return; }

  if(toggleBtn){
    const id = toggleBtn.getAttribute('data-toggle');
    const to = toggleBtn.getAttribute('data-to'); // active | passive
    try{
      await setResidentActive(id, to==='active');
      await renderResidentsTable();
      await renderDashboard();
    }catch(err){
      console.error(err);
      alert('Aktiflik değiştirilemedi: ' + (err?.message || 'Bilinmeyen hata'));
    }
    return;
  }

  if(editBtn){
    try{
      const id = editBtn.getAttribute('data-edit');
      const list = await listResidents();
      const rec = list.find(x=>x.id===id); if(!rec) return;
      editingResidentId = id;

      qs('#residentModalTitle') && (qs('#residentModalTitle').textContent = 'Sakini Düzenle');
      const f = qs('#formResident'); if(!f){ alert('Sakin formu bulunamadı'); return; }

      setInputValue(f, 'input[name="flatNo"]', rec.flatNo || '');
      setInputValue(f, 'input[name="name"]',   rec.name || '');
      setInputValue(f, 'input[name="phone"]',  rec.phone || '');
      setInputValue(f, 'input[name="email"]',  rec.email || '');
      const statusSel = f.querySelector('select[name="status"]');
      if(statusSel) setSelectSmart(statusSel, statusToEN(rec.status));
      setInputValue(f, 'input[name="licensePlate"]', rec.licensePlate || '');

      openModal(modalSel('#modalResident','#residentModal'));
    }catch(err){
      console.error(err);
      alert('Düzenleme açılamadı: ' + (err?.message || 'Bilinmeyen hata'));
    }
    return;
  }

  if(delBtn){
    const id = delBtn.getAttribute('data-del');
    if(confirm('Bu sakini silmek istiyor musunuz?')){
      await deleteResident(id);
      await renderResidentsTable();
      await renderDashboard();
    }
  }
}

// yeni sakin ekle
qs('#btnResidentAdd')?.addEventListener('click',(e)=>{
  e.preventDefault();
  if(currentRole!=='admin') return;
  assignFlatOnSave = null;
  editingResidentId = null;
  qs('#residentModalTitle') && (qs('#residentModalTitle').textContent = 'Sakin Ekle');
  qs('#formResident')?.reset();
  openModal(modalSel('#modalResident','#residentModal'));
});
qs('#addResident')?.addEventListener('click',(e)=>{
  e.preventDefault();
  if(currentRole!=='admin') return;
  assignFlatOnSave = null;
  editingResidentId = null;
  qs('#residentModalTitle') && (qs('#residentModalTitle').textContent = 'Sakin Ekle');
  qs('#formResident')?.reset();
  openModal(modalSel('#modalResident','#residentModal'));
});
qs('#formResident')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(currentRole!=='admin'){ alert('Sadece yönetici işlem yapabilir.'); return; }

  const formObj = Object.fromEntries(new FormData(e.target).entries());
  const nowISO = new Date().toISOString();

  try{
    if(editingResidentId){
      // Düzenlemede aktif/pasif durumunu KORU (yanlışlıkla aktifleşmesin)
      const list = await listResidents();
      const rec = list.find(x=>x.id===editingResidentId) || {};
      const payload = {
        ...rec,
        ...formObj,
        status: statusToEN(formObj.status),
        // rec.isActive aynen kalsın
        isActive: (typeof rec.isActive==='boolean') ? rec.isActive : true,
        moveInDate: rec.moveInDate || nowISO
      };
      await updateResident(editingResidentId, payload);
    }else{
      // Yeni kayıt: default aktif
      const payload = {
        ...formObj,
        status: statusToEN(formObj.status),
        isActive: true,
        moveInDate: nowISO
      };
      const res = await addResident(payload);

      // Aynı dairede varsa eski aktif sakini pasife al (taşınma senaryosu)
      const flatNo = String(payload.flatNo||'').trim();
      if(flatNo){
        await deactivateActiveResidentsForFlat(flatNo, res.id, nowISO);
      }

      assignFlatOnSave = null;
    }

    closeModals();
    e.target.reset();
    editingResidentId = null;
    await renderResidentsTable();
    await renderDashboard();
  }catch(err){
    console.error(err);
    alert('Kaydedilemedi: ' + (err?.message||'Bilinmeyen hata'));
  }
});

async function deactivateActiveResidentsForFlat(flatNo, newId, moveInISO){
  const list = await listResidents();
  const toClose = list.filter(r=> (r.flatNo||'')===flatNo && isResidentActive(r) && r.id!==newId);
  await Promise.all(toClose.map(r=> updateResident(r.id, { isActive:false, moveOutDate: moveInISO })));
}

/* ==================== PAYMENTS (Açıklama + Ay yönetimi) ==================== */
function paymentsToolbarHTML(){
  const years = Array.from({length: 8}, (_,i)=> new Date().getFullYear() - 4 + i);
  const yearOpts = ['<option value="">Yıl</option>', ...years.map(y=>`<option value="${y}">${y}</option>`)].join('');
  const monthOpts = `
    <option value="">Ay</option>
    <option value="01">Ocak</option><option value="02">Şubat</option><option value="03">Mart</option>
    <option value="04">Nisan</option><option value="05">Mayıs</option><option value="06">Haziran</option>
    <option value="07">Temmuz</option><option value="08">Ağustos</option><option value="09">Eylül</option>
    <option value="10">Ekim</option><option value="11">Kasım</option><option value="12">Aralık</option>
  `;
  return `
    <div class="row-gap" style="flex-wrap:wrap; margin:8px 0 12px;">
      <input id="paySearch" placeholder="Ara: isim / daire / ay / tarih / tür / açıklama" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;max-width:320px;">
      <select id="payResident" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;min-width:220px;">
        <option value="">Sakin (ID ile)</option>
      </select>
      <select id="payType" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;">
        <option value="">Tür: Tümü</option>
        <option value="Due">Aidat</option>
        <option value="Extra">Ek Ödeme</option>
      </select>
      <select id="payYear" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;">${yearOpts}</select>
      <select id="payMonth" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;">${monthOpts}</select>
      <button type="button" id="payReset" class="btn outline">Sıfırla</button>
      <span style="flex:1"></span>
      <button type="button" id="payExportCSV" class="btn outline">CSV</button>
    </div>
    <div class="table-container">
      <table class="tbl">
        <thead>
          <tr>
            <th>Ödeyen</th>
            <th>Daire</th>
            <th>Tür</th>
            <th>Ay</th>
            <th>Açıklama</th>
            <th>Tutar</th>
            <th>Tarih</th>
            <th>İşlemler</th>
          </tr>
        </thead>
        <tbody id="payTbody"></tbody>
        <tfoot>
          <tr>
            <td style="font-weight:700">Toplam</td>
            <td></td><td></td><td></td><td></td>
            <td id="payTotal" style="font-weight:700"></td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

async function ensurePaymentsUI(){
  const box = qs('#paymentList'); if(!box) return;
  let created = false;
  if(!qs('#payTbody')){ box.innerHTML = paymentsToolbarHTML(); created = true; }

  if(created){
    const resSel = qs('#payResident');
    if(resSel){
      const residents = await getResidentsCached();
      resSel.innerHTML = `<option value="">Sakin (ID ile)</option>` + residents
        .sort((a,b)=> (''+(a.flatNo||'')).localeCompare((''+(b.flatNo||'')),'tr',{numeric:true}) || (a.name||'').localeCompare(b.name||'', 'tr'))
        .map(r=>`<option value="${r.id}">${r.flatNo?`Daire ${r.flatNo} — `:''}${r.name||'-'}</option>`)
        .join('');
    }

    const onFilter = ()=> renderPaymentsTable();
    qs('#paySearch')?.addEventListener('input', onFilter);
    qs('#payResident')?.addEventListener('change', onFilter);
    qs('#payType')?.addEventListener('change', onFilter);
    qs('#payYear')?.addEventListener('change', onFilter);
    qs('#payMonth')?.addEventListener('change', onFilter);
    qs('#payReset')?.addEventListener('click', ()=>{
      qs('#paySearch').value='';
      qs('#payResident').value='';
      qs('#payType').value='';
      qs('#payYear').value='';
      qs('#payMonth').value='';
      renderPaymentsTable();
    });
    qs('#payExportCSV')?.addEventListener('click', exportPaymentsCSV);

    const payTbody = qs('#payTbody');
    if (payTbody && !payTbody.dataset.bound) {
      payTbody.addEventListener('click', onPaymentsTableClick);
      payTbody.dataset.bound = '1';
    }
  }
try{ enforceExportVisibility(); }catch(e){}
}

async function onPaymentsTableClick(e){
  const editBtn = e.target.closest('button[data-edit]');
  const delBtn  = e.target.closest('button[data-del]');
  if (!editBtn && !delBtn) return;
  e.preventDefault(); e.stopPropagation();
  if (currentRole !== 'admin') { alert('Sadece yönetici işlem yapabilir.'); return; }

  if (editBtn) {
    try {
      const id = editBtn.getAttribute('data-edit');
      const list = await listPayments();
      const rec = list.find(x=>x.id===id);
      if (!rec) return;

      editingPaymentId = id;

      await enhancePaymentForm();
      const f = qs('#formPayment');
      if (!f) { alert('Ödeme formu bulunamadı.'); return; }

      const residents = await getResidentsCached();
      const sel = qs('#residentSelect');
      let selectedId = rec.residentId || '';
      if (!selectedId && rec.residentName) {
        const match = residents.find(r => (r.name||'').trim().toLowerCase() === rec.residentName.trim().toLowerCase());
        selectedId = match?.id || '';
      }
      if (sel) sel.value = selectedId || '';
      const chosen = residents.find(r=>r.id===selectedId);

      setInputValue(f, 'input[name="flatNo"]',       rec.flatNo || chosen?.flatNo || '');
      setInputValue(f, 'input[name="residentId"]',   selectedId || '');

      const payer = rec.payerName || rec.residentName || chosen?.name || '';
      setInputValue(f, 'input[name="payerName"]', payer);

      const typSel = qs('#paymentType');
      const typeVal = (rec.type || rec.paymentType || 'Due');
      if (typSel) typSel.value = typeVal;

      const perField = f.querySelector('[name="period"], [name="month"]');
      if(perField) perField.value = typeVal === 'Extra' ? '' : (paymentPeriod(rec) || '');

      setInputValue(f, 'input[name="amount"]',      rec.amount ?? '');
      setInputValue(f, 'input[name="date"]',        rec.date ? toISODateInput(rec.date) : '');
      setInputValue(f, 'input[name="description"]', rec.description || '');

      toggleMonthVisibility();
      openModal(modalSel('#modalPayment','#paymentModal'));
    } catch (err) {
      console.error(err);
      alert('Düzenleme açılamadı: ' + (err?.message || 'Bilinmeyen hata'));
    }
  }

  if (delBtn) {
    try {
      const id = delBtn.getAttribute('data-del');
      if (!confirm('Bu ödemeyi silmek istiyor musunuz?')) return;
      await deletePayment(id);
      await renderPaymentsTable();
      await renderDashboard();
    } catch (err) {
      console.error(err);
      alert('Silinemedi: ' + (err?.message || 'Bilinmeyen hata'));
    }
  }
}

// Ödeme formunu zenginleştir: sakin select + daire + tür + açıklama
async function enhancePaymentForm(){
  const f = qs('#formPayment'); if(!f) return;

  // Tür (Aidat / Ek Ödeme)
  if(!qs('#paymentType')){
    const lab = document.createElement('label');
    lab.innerHTML = `Ödeme Türü
      <select id="paymentType" name="type" style="margin-top:6px">
        <option value="Due">Aidat</option>
        <option value="Extra">Ek Ödeme</option>
      </select>`;
    f.prepend(lab);
    qs('#paymentType')?.addEventListener('change', toggleMonthVisibility);
  }

  // residentId (opsiyonel) - raporlar için gerekmiyor ama filtreleme için faydalı
  if(!qs('input[name="residentId"]')){
    const hid = document.createElement('input');
    hid.type = 'hidden'; hid.name = 'residentId';
    f.appendChild(hid);
  }

  // Sakin seçimi (opsiyonel yardımcı alan): seçilirse daire no otomatik dolar
  if(!qs('#residentSelect')){
    const residents = await getResidentsCached();
    const lab = document.createElement('label');
    lab.textContent = 'Sakin Seç (opsiyonel)';
    const sel = document.createElement('select');
    sel.id = 'residentSelect';
    sel.name = 'residentSelect';
    sel.style.marginTop = '6px';
    sel.innerHTML = `<option value="">— Seçiniz —</option>` +
      residents
        .sort((a,b)=> (''+(a.flatNo||'')).localeCompare((''+(b.flatNo||'')),'tr',{numeric:true}) || (a.name||'').localeCompare(b.name||'', 'tr'))
        .map(r=>`<option value="${r.id}">${r.flatNo?`Daire ${r.flatNo} — `:''}${r.name||'-'}</option>`)
        .join('');
    lab.appendChild(sel);

    // Daire no alanının hemen altına ekle (yoksa en üste)
    const flatLabel = f.querySelector('input[name="flatNo"]')?.closest('label');
    if(flatLabel && flatLabel.parentNode){
      flatLabel.parentNode.insertBefore(lab, flatLabel.nextSibling);
    }else{
      f.prepend(lab);
    }

    sel.addEventListener('change', ()=>{
      const v = sel.value;
      const res = (_residentsCache||[]).find(r=>r.id===v);
      const idInp   = f.querySelector('input[name="residentId"]');
      const flatInp = f.querySelector('input[name="flatNo"]');
      const payerInp= f.querySelector('input[name="payerName"]');
      if(res){
        idInp && (idInp.value = res.id);
        flatInp && !flatInp.value && (flatInp.value = res.flatNo || '');
        // Ödeyen boşsa, seçilen sakini öner
        if(payerInp && !payerInp.value) payerInp.value = res.name || '';
      }else{
        idInp && (idInp.value = '');
      }
    });
  }

  // Açıklama alanı (Ek ödeme için zorunlu)
  if(!qs('#paymentDescription')){
    const periodWrapRef =
      f.querySelector('[name="period"]')?.closest('label') ||
      f.querySelector('[name="month"]')?.closest('label');
    const descWrap = document.createElement('label');
    descWrap.id = 'paymentDescWrap';
    descWrap.style.display = 'none';
    descWrap.innerHTML = `Açıklama
      <input id="paymentDescription" name="description" placeholder="Örn. asansör tamiri / bağış / gecikme cezası" />`;
    if(periodWrapRef && periodWrapRef.parentNode){
      periodWrapRef.parentNode.insertBefore(descWrap, periodWrapRef.nextSibling);
    } else {
      f.appendChild(descWrap);
    }
  }

  toggleMonthVisibility();
}

function paymentPeriod(rec){
  return ((rec?.month ?? rec?.period ?? '') + '').trim();
}
async function migratePaymentsFillFlatNo(){
  // Eski kayıtları otomatik toparla: flatNo yoksa residentId'den doldur.
  if(currentRole!=='admin') return;
  const flagKey = 'v2_migrated_flatno_2026_01';
  if(localStorage.getItem(flagKey)) return;

  try{
    const [payments, residents] = await Promise.all([listPayments(), getResidentsCached()]);
    const idToFlat = new Map(residents.map(r=>[r.id, String(r.flatNo||'').trim()]));
    let updated = 0;

    for(const p of (payments||[])){
      const patch = {};
      const flat = String(p.flatNo||'').trim();
      if(!flat && p.residentId){
        const f = idToFlat.get(p.residentId);
        if(f) patch.flatNo = f;
      }
      // payerName yoksa residentName'den doldur (geriye dönük)
      if(!p.payerName && p.residentName) patch.payerName = String(p.residentName||'').trim();
      // period alanı yoksa month'tan doldur
      if(!p.period && p.month) patch.period = String(p.month||'').trim();

      if(Object.keys(patch).length){
        await updatePayment(p.id, patch);
        updated++;
      }
    }

    localStorage.setItem(flagKey, '1');
    if(updated){
      console.log('V2 migration: payments patched =', updated);
    }
  }catch(err){
    console.warn('V2 migration failed:', err);
  }
}

// Ay/ Açıklama zorunluluğunu yönet zorunluluğunu yönet
function toggleMonthVisibility(){
  const f = qs('#formPayment'); if(!f) return;
  const typ = qs('#paymentType')?.value || 'Due';

  const monthField = f.querySelector('[name="month"]');
  const monthLabel = monthField?.closest('label') || monthField?.closest('.form-group') || monthField?.parentElement;

  const descInp  = qs('#paymentDescription');
  const descWrap = qs('#paymentDescWrap');

  if(typ === 'Extra'){
    if(monthLabel) monthLabel.style.display = 'none';
    if(monthField){
      monthField.required = false;
      monthField.removeAttribute('required');
      monthField.value = '';
      monthField.disabled = true;
    }
    if(descWrap) descWrap.style.display = '';
    if(descInp){ descInp.required = true; descInp.setAttribute('required',''); }
  }else{
    if(monthLabel) monthLabel.style.display = '';
    if(monthField){
      monthField.disabled = false;
      monthField.required = true;
      monthField.setAttribute('required','');
    }
    if(descWrap) descWrap.style.display = 'none';
    if(descInp){ descInp.required = false; descInp.removeAttribute('required'); descInp.value=''; }
  }
}

function matchPaymentFilters(rec, q, y, m, t, rid){
  let ok = true;
  const per = paymentPeriod(rec);
  if(q){
    const payer = (rec.payerName || rec.residentName || '');
    const hay = `${payer} ${rec.flatNo||''} ${per}
                 ${rec.description||''} ${typeToTR(rec.type||'Due')} ${fmtDate(rec.date)}`.toLowerCase();
    ok = hay.includes(q.toLowerCase());
  }
  if(ok && rid){ ok = (rec.residentId||'') === rid; }
  if(ok && t){ ok = (rec.type||'Due') === t; }
  if(ok && y){ ok = per.slice(0,4) === y; }
  if(ok && m){ ok = per.slice(5,7) === m; }
  return ok;
}

async function renderPaymentsTable(){
  await ensurePaymentsUI();
  const tbody = qs('#payTbody'); const totalCell = qs('#payTotal');
  if(!tbody) return;

  const [rows, residents] = await Promise.all([listPayments(), getResidentsCached()]);
  const idToFlat   = new Map(residents.map(r=>[r.id, String(r.flatNo||'')]));
  const nameToFlat = new Map(residents.map(r=>[(r.name||'').trim().toLowerCase(), String(r.flatNo||'')]));
  rows.forEach(r=>{
    if(!r.flatNo){
      if(r.residentId){
        const f = idToFlat.get(r.residentId);
        if(f) r._derivedFlatNo = f;
      }
      if(!r._derivedFlatNo && r.residentName){
        const f2 = nameToFlat.get(r.residentName.trim().toLowerCase());
        if(f2) r._derivedFlatNo = f2;
      }
    }
  });

  rows.sort((a,b)=>{
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  const q  = qs('#paySearch')?.value?.trim() || '';
  const y  = qs('#payYear')?.value || '';
  const m  = qs('#payMonth')?.value || '';
  const t  = qs('#payType')?.value || '';
  const rid= qs('#payResident')?.value || '';

  const normalized = rows.map(r=>({ ...r, type: (r.type || r.paymentType || 'Due') }));
  const filtered = normalized.filter(r=>matchPaymentFilters(
    { ...r, flatNo: r.flatNo || r._derivedFlatNo }, q, y, m, t, rid
  ));
  const isAdminUI = currentRole==='admin';

  let total = 0;
  tbody.innerHTML = filtered.map(r=>{
    const amount = +r.amount || 0; total += amount;
    const flat = r.flatNo || r._derivedFlatNo || '';
    const typTR = typeToTR(r.type);
    const monthText = r.type === 'Extra' ? '—' : (paymentPeriod(r) || '');
    const descText  = r.description || '—';
    return `
      <tr data-id="${r.id}">
        <td>${(r.payerName||r.residentName||'')}</td>
        <td>${flat||''}</td>
        <td>${typTR}</td>
        <td>${monthText}</td>
        <td>${descText}</td>
        <td>${fmtTRY.format(amount)}</td>
        <td>${fmtDate(r.date)}</td>
        <td>
          ${isAdminUI ? `
            <button type="button" class="btn small" data-edit="${r.id}">✏️ Düzenle</button>
            <button type="button" class="btn small danger" data-del="${r.id}">🗑️ Sil</button>
          ` : ''}
        </td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="8" style="text-align:center;color:#777;padding:16px">Henüz ödeme yok</td></tr>`;

  totalCell.textContent = fmtTRY.format(total);
}
try{ enforceExportVisibility(); }catch(e){}

async function exportPaymentsCSV(){
  const [rows, residents] = await Promise.all([listPayments(), getResidentsCached()]);
  const nameToFlat = new Map(residents.map(r=>[(r.name||'').trim().toLowerCase(), r.flatNo || '']));
  rows.forEach(r=>{
    if(!r.flatNo && r.residentName){
      const f = nameToFlat.get((r.residentName||'').trim().toLowerCase());
      if(f) r._derivedFlatNo = f;
    }
  });
  const q  = qs('#paySearch')?.value?.trim() || '';
  const y  = qs('#payYear')?.value || '';
  const m  = qs('#payMonth')?.value || '';
  const t  = qs('#payType')?.value || '';
  const rid= qs('#payResident')?.value || '';
  const normalized = rows.map(r=>({ ...r, type:(r.type||r.paymentType||'Due') }));
  const filtered = normalized.filter(r=> matchPaymentFilters({ ...r, flatNo: r.flatNo || r._derivedFlatNo }, q,y,m,t,rid));
  const headers = ['Odeyen','Daire','Tur','Ay','Aciklama','Tutar','Tarih'];
  const data = filtered.map(r=>{
    const flat = r.flatNo || r._derivedFlatNo || '';
    const type = r.type==='Extra' ? 'Ek' : 'Aidat';
    const month= r.type==='Extra' ? '' : (paymentPeriod(r) || '');
    const desc = r.description || '';
    const amount = (+r.amount||0).toFixed(2);
    const date = r.date ? (new Date(r.date)).toISOString().slice(0,10) : '';
    return [(r.payerName||r.residentName||''), String(flat), type, month, desc, amount, date];
  });
  const sep=','; const bom='\ufeff';
  const csv = ['sep=,', headers.join(sep), ...data.map(r=> r.map(v=>`"${trToAscii(String(v)).replace(/"/g,'""')}"`).join(sep))].join('\n');
  const blob = new Blob([bom+csv], {type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download = `payments-${new Date().toISOString().slice(0,10)}.csv`; a.click();
}

/* ==================== EXPENSES (Kategori + Not + Filtreler) ==================== */
const EXP_CATEGORIES = [
  'Temizlik','Genel','Elektrik','Su','Doğalgaz','Bakım',
  'Güvenlik','Sigorta','Asansör Bakım','Diğer'
];
function expensesToolbarHTML(){
  const years = Array.from({length: 8}, (_,i)=> new Date().getFullYear() - 4 + i);
  const yearOpts = ['<option value="">Yıl</option>', ...years.map(y=>`<option value="${y}">${y}</option>`)].join('');
  const monthOpts = `
    <option value="">Ay</option>
    <option value="01">Ocak</option><option value="02">Şubat</option><option value="03">Mart</option>
    <option value="04">Nisan</option><option value="05">Mayıs</option><option value="06">Haziran</option>
    <option value="07">Temmuz</option><option value="08">Ağustos</option><option value="09">Eylül</option>
    <option value="10">Ekim</option><option value="11">Kasım</option><option value="12">Aralık</option>
  `;
  const catOpts = ['<option value="">Kategori</option>', ...EXP_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`)].join('');
  return `
    <div class="row-gap" style="flex-wrap:wrap; margin:8px 0 12px;">
      <input id="expSearch" placeholder="Ara: kategori / not / tarih" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;max-width:320px;">
      <select id="expCategory" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;">${catOpts}</select>
      <select id="expYear" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;">${yearOpts}</select>
      <select id="expMonth" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;">${monthOpts}</select>
      <button type="button" id="expReset" class="btn outline">Sıfırla</button>
      <span style="flex:1"></span>
      <button type="button" id="expExportCSV" class="btn outline">CSV</button>
    </div>
    <div class="table-container">
      <table class="tbl">
        <thead>
          <tr>
            <th>Kategori</th>
            <th>Not</th>
            <th>Tutar</th>
            <th>Tarih</th>
            <th>İşlemler</th>
          </tr>
        </thead>
        <tbody id="expTbody"></tbody>
        <tfoot>
          <tr>
            <td style="font-weight:700">Toplam</td>
            <td></td>
            <td id="expTotal" style="font-weight:700"></td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}
async function ensureExpensesUI(){
  const box = qs('#expenseList'); if(!box) return;
  let created=false;
  if(!qs('#expTbody')){ box.innerHTML = expensesToolbarHTML(); created = true; }

  if(created){
    const onFilter = ()=> renderExpensesTable();
    qs('#expSearch')?.addEventListener('input', onFilter);
    qs('#expCategory')?.addEventListener('change', onFilter);
    qs('#expYear')?.addEventListener('change', onFilter);
    qs('#expMonth')?.addEventListener('change', onFilter);
    qs('#expReset')?.addEventListener('click', ()=>{
      qs('#expSearch').value='';
      qs('#expCategory').value='';
      qs('#expYear').value='';
      qs('#expMonth').value='';
      renderExpensesTable();
    });
    qs('#expExportCSV')?.addEventListener('click', exportExpensesCSV);

    const tb = qs('#expTbody');
    if(tb && !tb.dataset.bound){
      tb.addEventListener('click', onExpensesTableClick);
      tb.dataset.bound='1';
    }
  }
try{ enforceExportVisibility(); }catch(e){}
}
function matchExpenseFilters(rec, q, y, m, cat){
  let ok = true;
  if(q){
    const hay = `${rec.category||''} ${rec.note||''} ${fmtDate(rec.date)}`.toLowerCase();
    ok = hay.includes(q.toLowerCase());
  }
  if(ok && cat){ ok = (rec.category||'') === cat; }
  if(ok && y){
    const dt = rec.date? new Date(rec.date):null;
    ok = dt ? String(dt.getFullYear()) === y : false;
  }
  if(ok && m){
    const dt = rec.date? new Date(rec.date):null;
    ok = dt ? String(dt.getMonth()+1).padStart(2,'0') === m : false;
  }
  return ok;
}
async function renderExpensesTable(){
  await ensureExpensesUI();
  const tbody = qs('#expTbody'); const totalCell = qs('#expTotal');
  if(!tbody) return;

  const rows = await listExpenses();
  rows.sort((a,b)=>{
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  const q   = qs('#expSearch')?.value?.trim() || '';
  const cat = qs('#expCategory')?.value || '';
  const y   = qs('#expYear')?.value || '';
  const m   = qs('#expMonth')?.value || '';
  const isAdminUI = currentRole==='admin';

  const filtered = rows.filter(r=>matchExpenseFilters(r,q,y,m,cat));

  let total=0;
  tbody.innerHTML = filtered.map(r=>{
    const amount = +r.amount || 0; total += amount;
    return `
      <tr data-id="${r.id}">
        <td>${r.category||'-'}</td>
        <td>${r.note||'-'}</td>
        <td>${fmtTRY.format(amount)}</td>
        <td>${fmtDate(r.date)}</td>
        <td>
          ${isAdminUI ? `
            <button type="button" class="btn small" data-edit="${r.id}">✏️ Düzenle</button>
            <button type="button" class="btn small danger" data-del="${r.id}">🗑️ Sil</button>
          ` : ''}
        </td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="5" style="text-align:center;color:#777;padding:16px">Henüz gider yok</td></tr>`;

  totalCell.textContent = fmtTRY.format(total);
}
try{ enforceExportVisibility(); }catch(e){}
async function exportExpensesCSV(){
  const rows = await listExpenses();
  const q   = qs('#expSearch')?.value?.trim() || '';
  const cat = qs('#expCategory')?.value || '';
  const y   = qs('#expYear')?.value || '';
  const m   = qs('#expMonth')?.value || '';
  const filtered = rows.filter(r=> matchExpenseFilters(r,q,y,m,cat));
  const headers = ['Kategori','Not','Tutar','Tarih'];
  const data = filtered.map(r=>{
    const amount = (+r.amount||0).toFixed(2);
    const date = r.date ? (new Date(r.date)).toISOString().slice(0,10) : '';
    return [r.category||'', r.note||'', amount, date];
  });
  const sep=','; const bom='\ufeff';
  const csv = ['sep=,', headers.join(sep), ...data.map(r=> r.map(v=>`"${trToAscii(String(v)).replace(/"/g,'""')}"`).join(sep))].join('\n');
  const blob = new Blob([bom+csv], {type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download = `expenses-${new Date().toISOString().slice(0,10)}.csv`; a.click();
}
async function onExpensesTableClick(e){
  const editBtn = e.target.closest('button[data-edit]');
  const delBtn  = e.target.closest('button[data-del]');
  if (!editBtn && !delBtn) return;
  e.preventDefault(); e.stopPropagation();
  if (currentRole !== 'admin') { alert('Sadece yönetici işlem yapabilir.'); return; }

  if (editBtn) {
    try{
      const id = editBtn.getAttribute('data-edit');
      const list = await listExpenses();
      const rec = list.find(x=>x.id===id); if(!rec) return;
      editingExpenseId = id;

      await enhanceExpenseForm();
      const f = qs('#formExpense');
      if(!f){ alert('Gider formu bulunamadı.'); return; }

      const catSel = qs('#expenseCategory');
      if(catSel) catSel.value = rec.category || '';
      setInputValue(f, 'textarea[name="note"]',  rec.note || '');
      setInputValue(f, 'input[name="amount"]',   rec.amount ?? '');
      setInputValue(f, 'input[name="date"]',     rec.date ? toISODateInput(rec.date) : '');

      openModal(modalSel('#modalExpense','#expenseModal'));
    }catch(err){
      console.error(err);
      alert('Düzenleme açılamadı: ' + (err?.message || 'Bilinmeyen hata'));
    }
  }

  if (delBtn) {
    try{
      const id = delBtn.getAttribute('data-del');
      if (!confirm('Bu gideri silmek istiyor musunuz?')) return;
      await deleteExpense(id);
      await renderExpensesTable();
      await renderDashboard();
    }catch(err){
      console.error(err);
      alert('Silinemedi: ' + (err?.message || 'Bilinmeyen hata'));
    }
  }
}
async function enhanceExpenseForm(){
  const f = qs('#formExpense'); if(!f) return;

  // Kategori
  if(!qs('#expenseCategory')){
    const lab = document.createElement('label');
    lab.innerHTML = `Kategori
      <select id="expenseCategory" name="category" required style="margin-top:6px">
        ${EXP_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join('')}
      </select>`;
    const amountLabel = f.querySelector('input[name="amount"]')?.closest('label');
    if(amountLabel && amountLabel.parentNode){
      amountLabel.parentNode.insertBefore(lab, amountLabel);
    }else{
      f.prepend(lab);
    }
  }

  // Not
  if(!f.querySelector('textarea[name="note"]')){
    const lab = document.createElement('label');
    lab.innerHTML = `Not
      <textarea name="note" rows="2" placeholder="Kısa not (opsiyonel)"></textarea>`;
    const dateLabel = f.querySelector('input[name="date"]')?.closest('label');
    if(dateLabel && dateLabel.parentNode){
      dateLabel.parentNode.insertBefore(lab, dateLabel);
    }else{
      f.appendChild(lab);
    }
  }
}

/* ==================== Aidat / Ayarlamalar (FEES PAGE) ==================== */
function feesToolbarHTML(){
  const years = Array.from({length: 8}, (_,i)=> new Date().getFullYear() - 4 + i);
  const yearOpts = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  const monthOpts = `
    <option value="01">Ocak</option><option value="02">Şubat</option><option value="03">Mart</option>
    <option value="04">Nisan</option><option value="05">Mayıs</option><option value="06">Haziran</option>
    <option value="07">Temmuz</option><option value="08">Ağustos</option><option value="09">Eylül</option>
    <option value="10">Ekim</option><option value="11">Kasım</option><option value="12">Aralık</option>
  `;
  const now = new Date();
  const yNow = now.getFullYear();
  const mNow = String(now.getMonth()+1).padStart(2,'0');

  return `
  <div class="panel">
    <div class="panel-head">
      <h3>Aidat / Ayarlamalar</h3>
      <div class="row-gap" style="align-items:center">
        <select id="feeYear" class="pill">${yearOpts}</select>
        <select id="feeMonth" class="pill">${monthOpts}</select>
        <input id="feeDefault" type="number" min="0" step="0.01" placeholder="Varsayılan (₺)" class="pill" style="width:160px">
        <button id="feeApplyEmpty" class="btn outline admin-only">Boşlara uygula</button>
        <button id="feeCopyNext" class="btn outline admin-only">İleri aya kopyala</button>
        <button id="feeExportCSV" class="btn outline">CSV</button>
        <button id="feeSave" class="btn primary admin-only">Kaydet</button>
      </div>
    </div>
    <div class="mt">
      <div class="row-gap" style="margin:8px 0 12px;flex-wrap:wrap">
        <button id="feeAddFlat" class="btn outline admin-only">+ Daire ekle</button>
        <span class="muted">Not: “Yeni Sakin Ata” ile eski kayıtlar silinmez; önceki sakin pasif yapılır.</span>
      </div>
      <div class="table-container">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:120px">Daire</th>
              <th>Aktif Sakin</th>
              <th style="width:160px">Aidat (₺)</th>
              <th style="width:220px">İşlemler</th>
            </tr>
          </thead>
          <tbody id="feesTbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="panel" style="margin-top:14px">
    <div class="panel-head">
      <h3>➕ Yıllık Ek Ödeme</h3>
      <div class="row-gap" style="align-items:center;flex-wrap:wrap">
        <select id="extraYear" class="pill"></select>
        <input id="extraTitle" class="pill" placeholder="Açıklama (örn: Asansör yenileme)" style="min-width:260px">
        <input id="extraAmount" type="number" min="0" step="0.01" class="pill" placeholder="Daire başı yıllık (₺)" style="width:220px">
        <button id="extraSave" class="btn primary admin-only">Kaydet</button>
      </div>
    </div>
    <p class="muted" style="margin:6px 0 0">Bu tutar daire başı <b>yıllık</b> ek ödeme borcu olarak raporlara eklenir. Ek ödeme tahsilatları “Ödeme Ekle” ekranında <b>Tür: Ek Ödeme</b> seçilerek yapılır.</p>
    <div id="extraInfo" class="muted" style="margin-top:10px"></div>
  </div>

  <script>/* preselect current */</script>
  `;
}

function ymStr(y,m){ return `${y}-${m}`; }
function nextYM(ym){
  const [y,m] = ym.split('-').map(Number);
  const d = new Date(y, m-1, 1); d.setMonth(d.getMonth()+1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

async function ensureFeesUI(){
  const box = qs('#fees'); if(!box) return;
  if(!qs('#feesTbody')){
    box.innerHTML = feesToolbarHTML();
    // Default selections
    const now = new Date();
    qs('#feeYear').value = String(now.getFullYear());
    qs('#feeMonth').value = String(now.getMonth()+1).padStart(2,'0');

    // Extra payments UI
    const extraYearSel = qs('#extraYear');
    if(extraYearSel){
      extraYearSel.innerHTML = yearsOptionsHTML(9);
      extraYearSel.value = String(now.getFullYear());
      const loadExtraUI = async ()=>{
        const y = extraYearSel.value;
        const docx = await getExtraPaymentForYear(y);
        qs('#extraTitle').value = (docx?.title || '');
        qs('#extraAmount').value = (docx?.amount ?? '');
        const info = qs('#extraInfo');
        if(info){
          if(docx && (docx.amount || docx.title || docx.description)){
            info.innerHTML = `Kayıtlı: <b>${y}</b> — ${docx.title?docx.title+' — ':''}<b>${fmtTRY.format(+docx.amount||0)}</b> (daire başı / yıl)`;
          }else{
            info.innerHTML = `Bu yıl için ek ödeme tanımı yok.`;
          }
        }
      };
      extraYearSel.addEventListener('change', loadExtraUI);

      qs('#extraSave')?.addEventListener('click', async ()=>{
        if(currentRole!=='admin'){ alert('Yetki yok'); return; }
        const y = extraYearSel.value;
        const title = (qs('#extraTitle')?.value || '').trim();
        const amount = +(qs('#extraAmount')?.value || 0);
        if(!(amount>=0)){ alert('Tutar geçersiz'); return; }
        await setExtraPaymentDoc(y, { title, amount });
        await loadExtraUI();
        alert('Ek ödeme kaydedildi.');
        // reports page might be open
        try{ await renderReportsTable(); }catch(e){}
      });

      // initial
      loadExtraUI();
    }


    const onChange = async ()=>{ await loadFeesForSelectors(); await renderFeesTable(); };
    qs('#feeYear')?.addEventListener('change', onChange);
    qs('#feeMonth')?.addEventListener('change', onChange);
    qs('#feeDefault')?.addEventListener('input', ()=>{ feesState.defaultAmount = +(qs('#feeDefault').value||0); });

    qs('#feeApplyEmpty')?.addEventListener('click', ()=>{ applyDefaultToEmptyRows(); renderFeesTable(); });
    qs('#feeCopyNext')?.addEventListener('click', async ()=>{ await copyFeesToNextMonth(); alert('İleri aya kopyalandı.'); });
    qs('#feeSave')?.addEventListener('click', saveFees);
    qs('#feeExportCSV')?.addEventListener('click', exportFeesCSV);
    qs('#feeAddFlat')?.addEventListener('click', ()=>{ addFlatRow(''); renderFeesTable(); });

    const tb = qs('#feesTbody');
    tb?.addEventListener('input', onFeesTbodyInput);
    tb?.addEventListener('click', onFeesTbodyClick);

    await loadFeesForSelectors();
  }
}

async function loadFeesForSelectors(){
  const y = qs('#feeYear')?.value; const m = qs('#feeMonth')?.value;
  const ym = ymStr(y,m);
  const feesDoc = await getFeesDoc(ym);
  feesState.ym = ym;
  feesState.defaultAmount = +(feesDoc?.defaultAmount || 0);
  feesState.items = {...(feesDoc?.items||{})};

  // UI input
  const defInp = qs('#feeDefault'); if(defInp) defInp.value = feesState.defaultAmount || '';

  // Rows adayları: aktif sakinlerin daireleri + mevcut fees'teki daireler
  const residents = await getResidentsCached();
  const activeFlats = new Set(residents.filter(isResidentActive).map(r=> String(r.flatNo||'').trim()).filter(Boolean));
  const feeFlats = new Set(Object.keys(feesState.items||{}));
  feesState._rows = Array.from(new Set([...activeFlats, ...feeFlats])).sort((a,b)=>(''+a).localeCompare((''+b),'tr',{numeric:true}));
}

function addFlatRow(flatNo){
  const f = String(flatNo||'').trim();
  if(!f) {
    const v = prompt('Daire No girin:');
    if(!v) return;
    feesState._rows.push(String(v).trim());
    feesState._rows = Array.from(new Set(feesState._rows)).sort((a,b)=>(''+a).localeCompare((''+b),'tr',{numeric:true}));
    return;
  }
  feesState._rows.push(f);
  feesState._rows = Array.from(new Set(feesState._rows)).sort((a,b)=>(''+a).localeCompare((''+b),'tr',{numeric:true}));
}

function applyDefaultToEmptyRows(){
  feesState._rows.forEach(flat=>{
    if(!feesState.items[flat] && feesState.defaultAmount>0){
      feesState.items[flat] = feesState.defaultAmount;
    }
  });
}

async function copyFeesToNextMonth(){
  const next = nextYM(feesState.ym);
  await setFeesDoc(next, { defaultAmount: feesState.defaultAmount, items: feesState.items });
}

function getActiveResidentNameForFlat(flatNo, residents){
  const list = residents.filter(r=> String(r.flatNo||'').trim() === String(flatNo).trim());
  const active = list.find(isResidentActive);
  return active?.name || '';
}

async function renderFeesTable(){
  const tb = qs('#feesTbody'); if(!tb) return;
  const residents = await getResidentsCached();

  if(!feesState._rows || feesState._rows.length===0){
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#777;padding:16px">Daire listesi yok. “Daire ekle” ile başlayın.</td></tr>`;
    return;
  }

  tb.innerHTML = feesState._rows.map(flat=>{
    const amount = feesState.items[flat] ?? '';
    const rName = getActiveResidentNameForFlat(flat, residents) || '<em>—</em>';
    const row = `
      <tr data-flat="${flat}">
        <td><input class="pill" data-key="flat" value="${flat}" style="min-width:90px"></td>
        <td>${rName}</td>
        <td><input class="pill" data-key="amount" type="number" min="0" step="0.01" placeholder="${feesState.defaultAmount||0}" value="${amount}"></td>
        <td>
          ${currentRole==='admin' ? `
            <button class="btn small" data-assign="${flat}">👤 Yeni Sakin Ata</button>
            <button class="btn small outline" data-clear="${flat}">Temizle</button>
          ` : ''}
        </td>
      </tr>
    `;
    return row;
  }).join('');
}

function onFeesTbodyInput(e){
  const tr = e.target.closest('tr'); if(!tr) return;
  const flatOld = tr.getAttribute('data-flat');
  const key = e.target.getAttribute('data-key');
  if(!key) return;

  if(key==='flat'){
    const newFlat = String(e.target.value||'').trim();
    // flat değişirse, items anahtarı da değişir
    const val = feesState.items[flatOld];
    delete feesState.items[flatOld];
    tr.setAttribute('data-flat', newFlat);
    if(newFlat) feesState.items[newFlat] = val;
    // _rows güncelle
    feesState._rows = feesState._rows.map(f=> f===flatOld? newFlat : f);
  }

  if(key==='amount'){
    const newVal = e.target.value;
    const flat = tr.getAttribute('data-flat');
    if(!flat) return;
    if(newVal==='' || isNaN(+newVal)) delete feesState.items[flat];
    else feesState.items[flat] = +newVal;
  }
}

function onFeesTbodyClick(e){
  const assignBtn = e.target.closest('button[data-assign]');
  const clearBtn  = e.target.closest('button[data-clear]');
  if(!assignBtn && !clearBtn) return;
  if(currentRole!=='admin'){ alert('Sadece yönetici işlem yapabilir.'); return; }

  if(assignBtn){
    const flat = assignBtn.getAttribute('data-assign');
    openAssignResidentForFlat(flat);
  }
  if(clearBtn){
    const flat = clearBtn.getAttribute('data-clear');
    delete feesState.items[flat];
    renderFeesTable();
  }
}

async function openAssignResidentForFlat(flat){
  if(!flat){ alert('Daire numarası yok.'); return; }
  assignFlatOnSave = String(flat).trim();

  // Sakin formunu resetle ve daireyi doldur
  const form = qs('#formResident');
  if(!form){ alert('Sakin formu bulunamadı.'); return; }
  form.reset();
  const title = qs('#residentModalTitle'); if(title) title.textContent = `Yeni Sakin Ata (Daire ${flat})`;
  setInputValue(form, 'input[name="flatNo"]', assignFlatOnSave);

  editingResidentId = null;
  openModal(modalSel('#modalResident','#residentModal'));
}

async function saveFees(){
  try{
    await setFeesDoc(feesState.ym, { defaultAmount: feesState.defaultAmount, items: feesState.items });
    alert('Kaydedildi.');
  }catch(err){
    console.error(err);
    alert('Kaydedilemedi: ' + (err?.message || 'Bilinmeyen hata'));
  }
}

async function exportFeesCSV(){
  if(!feesState._rows?.length){ alert('Dışa aktaracak veri yok.'); return; }
  const residents = await getResidentsCached();
  const headers = ['Daire','Sakin','Tutar'];
  const data = feesState._rows.map(flat=>{
    const name = getActiveResidentNameForFlat(flat, residents) || '';
    const amt = feesState.items[flat] ?? '';
    return [flat, name, amt];
  });
  const csv = [headers, ...data].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fees-${feesState.ym}.csv`;
  a.click();
}

/* ==================== Modals ==================== */
const backdrop = qs('#modalBackdrop');
function openModal(sel){ const m=qs(sel); if(!m){ console.warn('Modal not found:', sel); return; } show(m); show(qs('#modalBackdrop')); }
function closeModals(){
  hide(backdrop); qsa('.modal').forEach(m=>hide(m));
  editingPaymentId = null;
  editingResidentId = null;
  editingAnnouncementId = null;
  editingExpenseId = null;
  // assignFlatOnSave kalabilir; sakin kayıt tamamlanınca sıfırlanıyor
}
backdrop?.addEventListener('click',closeModals);
qsa('.modal [data-close]')?.forEach(b=>b.addEventListener('click',closeModals));

/* Açma butonları */
qs('#addAnnouncement')?.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();editingAnnouncementId=null; qs('#formAnnouncement').reset(); openModal(modalSel('#modalAnnouncement','#announcementModal'));});
qs('#addPayment')?.addEventListener('click', async (e)=>{
  e.preventDefault();e.stopPropagation();
  editingPaymentId=null;
  qs('#formPayment')?.reset();
  await enhancePaymentForm();
  const sel = qs('#residentSelect'); if(sel) sel.value='';
  const idInp = qs('input[name="residentId"]'); if(idInp) idInp.value='';
  const typSel = qs('#paymentType'); if(typSel) typSel.value='Due';
  toggleMonthVisibility();
  openModal(modalSel('#modalPayment','#paymentModal'));
});
qs('#addExpense')?.addEventListener('click', async (e)=>{
  e.preventDefault();e.stopPropagation();
  editingExpenseId = null;
  qs('#formExpense')?.reset();
  await enhanceExpenseForm();
  openModal(modalSel('#modalExpense','#expenseModal'));
});
qs('#setFee')?.addEventListener('click',async (e)=>{
  e.preventDefault();e.stopPropagation();
  await ensureFeesUI(); await renderFeesTable();
  showPage('fees');
});

/* Duyuru form */
qs('#formAnnouncement')?.addEventListener('submit', async (e)=>{
  e.preventDefault(); if(currentRole!=='admin') return;
  const fd=new FormData(e.target); const data=Object.fromEntries(fd.entries());
  if(editingAnnouncementId){ await updateAnnouncement(editingAnnouncementId,{title:data.title,type:data.type||'info',content:data.content}); }
  else { await addAnnouncement({title:data.title,type:data.type||'info',content:data.content}); }
  editingAnnouncementId=null; e.target.reset(); closeModals(); await renderAnnouncements();
});

/* === Admin Bilgileri formu (iki id destekli) === */
const adminForm = qs('#adminInfoForm') || qs('#formAdminInfo');
adminForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (currentRole !== 'admin') { alert('Sadece yönetici düzenleyebilir.'); return; }

  const data = Object.fromEntries(new FormData(e.target).entries());

  const patch = {};
  if (editingRole === 'admin' || editingRole === 'all') {
    patch.adminName  = (data.adminName  || '').trim();
    patch.adminPhone = (data.adminPhone || '').trim();
  }
  if (editingRole === 'assistant' || editingRole === 'all') {
    patch.assistantName  = (data.assistantName  || '').trim();
    patch.assistantPhone = (data.assistantPhone || '').trim();
  }
  if (editingRole === 'supervisor' || editingRole === 'all') {
    patch.supervisorName  = (data.supervisorName  || '').trim();
    patch.supervisorPhone = (data.supervisorPhone || '').trim();
  }

  try {
    await setAdminInfoDoc(patch);
    closeModals();
    await renderAdminInfo();
  } catch (err) {
    console.error(err);
    alert('Kaydedilemedi: ' + (err?.message || 'Bilinmeyen hata'));
  }
});

/* Ödeme formu */
qs('#formPayment')?.addEventListener('submit', async (e)=>{
  e.preventDefault(); if(currentRole!=='admin') return;
  const o = Object.fromEntries(new FormData(e.target).entries());

  const date = o.date ? new Date(o.date).toISOString() : new Date().toISOString();
  const type = o.type ? o.type : 'Due';

  // Aidat/Ek ödeme dönemi: yeni formda "period" kullanıyoruz, eski kayıtlarda "month" olabilir
  const periodVal = (type === 'Extra') ? '' : ((o.period || o.month || '').trim());
  const descVal   = (type === 'Extra') ? ((o.description || '').trim()) : '';

  const flatNo = (o.flatNo || '').trim();

  const payload = {
    residentId: (o.residentId || '').trim(), // opsiyonel
    payerName: (o.payerName || '').trim(),
    residentName: ((o.payerName || '')).trim(), // geriye dönük uyumluluk
    flatNo,
    type,
    month: periodVal,   // geriye dönük uyumluluk
    period: periodVal,  // yeni alan
    description: descVal,
    amount: +(o.amount||0),
    date
  };

  try{
    if(editingPaymentId){
      await updatePayment(editingPaymentId, payload);
    }else{
      await addPayment(payload);
    }
    editingPaymentId = null;
    e.target.reset(); closeModals();
    await renderPaymentsTable(); await renderDashboard();
  }catch(err){
    console.error(err);
    alert('Kaydedilemedi: ' + (err?.message||'Bilinmeyen hata'));
  }
});

/* Gider formu */
qs('#formExpense')?.addEventListener('submit', async (e)=>{
  e.preventDefault(); if(currentRole!=='admin') return;
  await enhanceExpenseForm();
  const o = Object.fromEntries(new FormData(e.target).entries());
  const date = o.date ? new Date(o.date).toISOString() : new Date().toISOString();
  const payload = {
    category: o.category || EXP_CATEGORIES[0],
    note: (o.note || '').trim(),
    amount: +(o.amount || 0),
    date
  };
  try{
    if(editingExpenseId){ await updateExpense(editingExpenseId, payload); }
    else{ await addExpense(payload); }
    editingExpenseId = null;
    e.target.reset(); closeModals();
    await renderExpensesTable(); await renderDashboard();
  }catch(err){
    console.error(err);
    alert('Kaydedilemedi: ' + (err?.message||'Bilinmeyen hata'));
  }
});

/* ==================== Auth State ==================== */
onAuthStateChanged(auth, async (user)=>{
  // Force login prompt unless this tab performed a manual sign-in in this session
  try{ if(user && !sessionStorage.getItem('manualSignInThisSession') && !window.__loginInProgress){ await signOut(auth); return; } }catch{}

  currentUser = user || null;
  if(!currentUser){
    show(qs('#loginView')); hide(qs('#appView')); hide(qs('#nav')); hide(qs('#userBox')); return;
  }

  currentRole = (await fetchRole(currentUser.uid)) ? 'admin' : 'user';
  if (typeof migratePaymentsFillFlatNo === 'function') { await migratePaymentsFillFlatNo(); }
  qsa('.admin-only').forEach(el=> currentRole==='admin'?show(el):hide(el));
  // Hide export buttons by id for non-admins
  if(currentRole!=='admin'){
    ['exportPayments','exportExpenses','payExportCSV','expExportCSV'].forEach(id=>{
      const el = document.getElementById(id);
      if(el){
        el.style.display = 'none';
        el.setAttribute('aria-disabled','true');
        el.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); }, { once:true });
      }
    });
    // Generic: hide any button/link that contains CSV or JSON text
    document.querySelectorAll('button, a').forEach(el=>{
      const text = (el.textContent||'').toLowerCase();
      if(text.includes('csv') || text.includes('json')){
        el.style.display = 'none';
        el.setAttribute('aria-disabled','true');
        el.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); }, { once:true });
      }
    });
  }

  qs('#userEmail').textContent = currentUser.email || '';
  qs('#userRole').textContent  = currentRole==='admin' ? 'Admin' : 'Kullanıcı';

  hide(qs('#loginView')); show(qs('#appView')); show(qs('#nav')); show(qs('#userBox'));
  showPage('dashboard');

  await ensureAdminInfoDoc();

  await Promise.all([
    renderDashboard(),
    renderAnnouncements(),
    renderAdminInfo(),
    renderResidentsTable(),
    (async ()=>{ await ensurePaymentsUI(); await renderPaymentsTable(); })(),
    (async ()=>{ await ensureExpensesUI(); await renderExpensesTable(); })(),
    (async ()=>{ await ensureFeesUI(); await renderFeesTable(); })()
  ]);
});

/* ==================== Minor ==================== */
try{ (function(){const __el=document.getElementById('yearCopy'); if(__el) __el.textContent=new Date().getFullYear();})() }catch{}