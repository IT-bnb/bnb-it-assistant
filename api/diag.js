const SHEET_ID = '1n1TnyQleh14cGKTbtiOA5hDFEnwcF7JB3t47CUZs_aM';
const API_KEY  = process.env.GOOGLE_API_KEY || 'AIzaSyAal8LEHSuYYrocWDEZVsyOMOubommjvko';
function cleanPem(raw) {
  let k=raw.trim();
  if((k.startsWith('"')&&k.endsWith('"'))||(k.startsWith("'")&&k.endsWith("'")))k=k.slice(1,-1);
  return k.replace(/^"+|"+$/g,'').replace(/\\n/g,'\n');
}
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  const SA_KEY = process.env.GOOGLE_SA_PRIVATE_KEY;
  const report = {
    timestamp: new Date().toISOString(),
    env:{sa_key_set:!!SA_KEY,sa_key_len:SA_KEY?SA_KEY.length:0,api_key_env:!!process.env.GOOGLE_API_KEY,anthropic:!!process.env.ANTHROPIC_API_KEY,nim:!!process.env.NIM_API_KEY},
    api_key_test:null, sa_parse_test:null, sa_token_test:null
  };
  try {
    const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/IT%20Asset%20Inventory?key=${API_KEY}`);
    const d=await r.json();
    report.api_key_test={ok:r.ok,rows:d.values?.length||0,error:d.error?.message||null};
  } catch(e){report.api_key_test={error:e.message};}
  if (SA_KEY) {
    try {
      const pem=cleanPem(SA_KEY),body=pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
      const kb=Buffer.from(body,'base64');
      await crypto.subtle.importKey('pkcs8',kb,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
      report.sa_parse_test={ok:true,bytes:kb.byteLength};
      // Also test actual token
      function b64u(s){return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
      const now=Math.floor(Date.now()/1000);
      const claim={iss:'bnb-it-sheets@blissful-racer-490505-d2.iam.gserviceaccount.com',scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now};
      const si=`${b64u(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64u(JSON.stringify(claim))}`;
      const ck=await crypto.subtle.importKey('pkcs8',kb,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
      const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',ck,new TextEncoder().encode(si));
      const jwt=`${si}.${Buffer.from(sig).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`;
      const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`});
      const td=await tr.json();
      report.sa_token_test={ok:!!td.access_token,error:td.error||null,desc:td.error_description||null};
    } catch(e){report.sa_parse_test={ok:false,error:e.message};}
  }
  return res.status(200).json(report);
};
