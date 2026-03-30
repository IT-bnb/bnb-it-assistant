module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  try {
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.NIM_API_KEY},
      body:JSON.stringify(req.body)
    });
    const d = await r.json();
    return res.status(r.status).json(d);
  } catch(e) { return res.status(500).json({error:e.message}); }
};
