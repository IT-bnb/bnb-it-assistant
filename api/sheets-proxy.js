const SHEET_ID = '1n1TnyQleh14cGKTbtiOA5hDFEnwcF7JB3t47CUZs_aM';
const SA_EMAIL = 'bnb-it-sheets@blissful-racer-490505-d2.iam.gserviceaccount.com';
const SA_KEY   = process.env.GOOGLE_SA_PRIVATE_KEY;
const API_KEY  = process.env.GOOGLE_API_KEY || 'AIzaSyAal8LEHSuYYrocWDEZVsyOMOubommjvko';

function b64u(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function cleanPem(raw) {
  let k = raw.trim();
  if ((k.startsWith('"')&&k.endsWith('"'))||(k.startsWith("'")&&k.endsWith("'"))) k=k.slice(1,-1);
  k = k.replace(/^"+|"+$/g,'').replace(/\\n/g,'\n');
  return k;
}
async function getToken() {
  const pem  = cleanPem(SA_KEY);
  const body = pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const kb   = Buffer.from(body,'base64');
  const now  = Math.floor(Date.now()/1000);
  const claim = {iss:SA_EMAIL,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now};
  const si   = `${b64u(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64u(JSON.stringify(claim))}`;
  const ck   = await crypto.subtle.importKey('pkcs8',kb,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig  = await crypto.subtle.sign('RSASSA-PKCS1-v1_5',ck,new TextEncoder().encode(si));
  const jwt  = `${si}.${Buffer.from(sig).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`;
  const tr   = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`});
  const td   = await tr.json();
  if (!td.access_token) throw new Error('SA_TOKEN_FAIL:'+JSON.stringify(td).slice(0,200));
  return td.access_token;
}
async function readSheet(sheet) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheet)}`;
  if (SA_KEY) {
    try {
      const token = await getToken();
      const r = await fetch(base,{headers:{'Authorization':'Bearer '+token}});
      const d = await r.json();
      if (r.ok && d.values) { console.log('[SA OK]',sheet,d.values.length); return {ok:true,data:d}; }
      console.log('[SA FAIL]',sheet,r.status,JSON.stringify(d).slice(0,150));
    } catch(e) { console.log('[SA ERR]',e.message.slice(0,150)); }
  }
  try {
    const r2 = await fetch(`${base}?key=${API_KEY}`);
    const d2 = await r2.json();
    if (r2.ok && d2.values) { console.log('[APIKEY OK]',sheet,d2.values.length); return {ok:true,data:d2}; }
    console.log('[APIKEY FAIL]',sheet,r2.status,JSON.stringify(d2).slice(0,150));
    return {ok:false,error:d2?.error?.message||'both methods failed'};
  } catch(e) { return {ok:false,error:e.message}; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  try {
    const sheet = req.query.sheet || 'IT Asset Inventory';
    const base  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
    if (req.method==='GET') {
      const result = await readSheet(sheet);
      if (result.ok) return res.status(200).json(result.data);
      return res.status(502).json({error:result.error,sheet});
    }
    if (!SA_KEY) return res.status(500).json({error:'GOOGLE_SA_PRIVATE_KEY not set'});
    const token = await getToken();
    const authH = {'Authorization':'Bearer '+token,'Content-Type':'application/json'};
    const body  = req.body||{};
    let url,r,d;
    if (body.action==='append') {
      const s=body.sheet||sheet;
      url=`${base}/values/${encodeURIComponent(s)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      r=await fetch(url,{method:'POST',headers:authH,body:JSON.stringify({values:[body.row]})});
      d=await r.json(); return res.status(r.status).json(d);
    }
    if (body.action==='update') {
      url=`${base}/values/${encodeURIComponent(body.range)}?valueInputOption=USER_ENTERED`;
      r=await fetch(url,{method:'PUT',headers:authH,body:JSON.stringify({range:body.range,values:body.values})});
      d=await r.json(); return res.status(r.status).json(d);
    }
    return res.status(400).json({error:'Unknown action'});
  } catch(e) { return res.status(500).json({error:e.message}); }
};
