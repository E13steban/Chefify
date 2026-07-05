import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, deleteDoc } from "firebase/firestore";

// ─── FIREBASE ────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// ─── TEMA ────────────────────────────────────────────────────────────────────
const DARK = {
  bg:"#0a1a0a",surface:"#121f12",card:"#182818",border:"#1e3a1e",
  borderLight:"#2d5a2d",green:"#6fcf6f",greenDim:"#4a8a4a",greenFaint:"#1a3a1a",
  text:"#e0ede0",textMuted:"#7aaa7a",textDim:"#4a7a4a",
  accent:"#ff6b35",accentDim:"#2a1a0a",gold:"#f0c040",goldDim:"#2a2010",
  inputBg:"#1a3a1a",shadow:"#00000060",
};
const LIGHT = {
  bg:"#f5faf5",surface:"#ffffff",card:"#edf6ed",border:"#c8e0c8",
  borderLight:"#6ab56a",green:"#2d7a2d",greenDim:"#4a9a4a",greenFaint:"#dff0df",
  text:"#1a2e1a",textMuted:"#4a7a4a",textDim:"#8aaa8a",
  accent:"#e05010",accentDim:"#fce8e0",gold:"#b07800",goldDim:"#fff8e0",
  inputBg:"#edf6ed",shadow:"#0000001a",
};

const MEAL_TYPES=["Cualquiera","Desayuno","Almuerzo","Cena","Snack"];
const DIFFICULTIES=["Fácil","Media","Difícil"];
const TIMES=["15 min","30 min","1 hora","Sin límite"];
const PERSONS=["1 persona","2 personas","3-4 personas","5-6 personas","Más de 6"];
const CUISINES=["Cualquiera","🇲🇽 Mexicana","🇮🇹 Italiana","🇯🇵 Asiática","🇺🇸 Americana","🌍 Mediterránea","🌎 Latinoamericana","✨ Sorpréndeme"];
const RESTRICTIONS=["Vegetariano","Vegano","Sin gluten","Sin lactosa","Sin cerdo","Sin mariscos","Keto","Bajo en carbohidratos","Alto en proteína"];
const ALLERGIES=["Nueces","Mariscos","Lácteos","Huevo","Trigo","Soya","Cacahuate","Pescado","Sésamo"];
const GOALS=["Bajar de peso","Ganar músculo","Comer más sano","Mantener peso","Sin objetivo"];
const DAILY_LIMIT = 3;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function callAI(prompt, imageBase64=null) {
  const content = imageBase64
    ? [{type:"image",source:{type:"base64",media_type:"image/jpeg",data:imageBase64}},{type:"text",text:prompt}]
    : prompt;
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":import.meta.env.VITE_ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
    body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1500,messages:[{role:"user",content}]}),
  });
  const data = await res.json();
  const text = data.content?.map(b=>b.text||"").join("")||"";
  return JSON.parse(text.replace(/```json|```/g,"").trim());
}

async function fetchFoodImage(query) {
  try {
    const q = encodeURIComponent(query + " food dish plated");
    const res = await fetch(`https://api.unsplash.com/search/photos?query=${q}&per_page=1&orientation=landscape&client_id=${import.meta.env.VITE_UNSPLASH_KEY}`);
    const data = await res.json();
    return data.results?.[0]?.urls?.regular || null;
  } catch { return null; }
}

function buildProfileContext(profile) {
  const parts=[];
  if(profile.restrictions?.length) parts.push(`Restricciones: ${profile.restrictions.join(", ")}`);
  if(profile.allergies?.length) parts.push(`Alergias: ${profile.allergies.join(", ")}`);
  if(profile.dislikes?.length) parts.push(`No le gusta: ${profile.dislikes.join(", ")}`);
  if(profile.goal&&profile.goal!=="Sin objetivo") parts.push(`Objetivo: ${profile.goal}`);
  return parts.length?`\nPerfil: ${parts.join(". ")}.`:"";
}

// ─── FIRESTORE HELPERS ───────────────────────────────────────────────────────
async function saveToFirestore(uid, key, data) {
  try { await setDoc(doc(db, "users", uid, "data", key), { value: JSON.stringify(data) }); } catch {}
}
async function loadFromFirestore(uid, key) {
  try {
    const snap = await getDoc(doc(db, "users", uid, "data", key));
    if(snap.exists()) return JSON.parse(snap.data().value);
  } catch {}
  return null;
}

// ─── DAILY LIMIT ─────────────────────────────────────────────────────────────
function useDailyLimit(isPremium) {
  const [count, setCount] = useState(0);
  const today = new Date().toDateString();
  useEffect(()=>{
    try {
      const saved = localStorage.getItem("chefify-daily");
      if(saved) {
        const { date, count: c } = JSON.parse(saved);
        if(date === today) setCount(c);
        else { localStorage.setItem("chefify-daily", JSON.stringify({date:today,count:0})); setCount(0); }
      }
    } catch {}
  },[]);
  const increment = () => {
    const n = count + 1; setCount(n);
    try { localStorage.setItem("chefify-daily", JSON.stringify({date:today,count:n})); } catch {}
  };
  return { canGenerate: isPremium || count < DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT-count), increment };
}

// ─── TOAST ───────────────────────────────────────────────────────────────────
let _toast=null;
function ToastProvider({C}) {
  const [msg,setMsg]=useState("");
  _toast=(m)=>{setMsg(m);setTimeout(()=>setMsg(""),2400);};
  if(!msg)return null;
  return(
    <div style={{position:"fixed",bottom:"90px",left:"50%",transform:"translateX(-50%)",zIndex:999}}>
      <div style={{background:C.card,border:`1px solid ${C.borderLight}`,borderRadius:"10px",color:C.green,fontSize:"0.82rem",padding:"10px 18px",whiteSpace:"nowrap",boxShadow:`0 4px 20px ${C.shadow}`}}>{msg}</div>
    </div>
  );
}
const toast=(m)=>_toast&&_toast(m);

// ─── CHIPS ───────────────────────────────────────────────────────────────────
function FilterChips({label,options,value,onChange,C}) {
  const chip={background:C.greenFaint,border:`1px solid ${C.border}`,borderRadius:"8px",color:C.textMuted,cursor:"pointer",fontSize:"0.78rem",padding:"6px 12px",fontFamily:"Georgia,serif"};
  const chipA={...chip,background:C.borderLight,border:`1px solid ${C.green}`,color:C.green};
  return(<>
    <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px",marginTop:"18px"}}>{label}</span>
    <div style={{display:"flex",flexWrap:"wrap",gap:"7px",marginTop:"4px"}}>
      {options.map(o=><button key={o} style={value===o?chipA:chip} onClick={()=>onChange(o)}>{o}</button>)}
    </div>
  </>);
}
function MultiChips({label,options,selected,onChange,C}) {
  const chip={background:C.greenFaint,border:`1px solid ${C.border}`,borderRadius:"8px",color:C.textMuted,cursor:"pointer",fontSize:"0.78rem",padding:"6px 12px",fontFamily:"Georgia,serif"};
  const chipA={...chip,background:C.borderLight,border:`1px solid ${C.green}`,color:C.green};
  const toggle=o=>onChange(selected.includes(o)?selected.filter(x=>x!==o):[...selected,o]);
  return(<>
    <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px",marginTop:"18px"}}>{label}</span>
    <div style={{display:"flex",flexWrap:"wrap",gap:"7px",marginTop:"4px"}}>
      {options.map(o=><button key={o} style={selected.includes(o)?chipA:chip} onClick={()=>toggle(o)}>{o}</button>)}
    </div>
  </>);
}

// ─── STEP TIMER ──────────────────────────────────────────────────────────────
function StepTimer({step,C}) {
  const [seconds,setSeconds]=useState(0);
  const [running,setRunning]=useState(false);
  const [done,setDone]=useState(false);
  const ref=useRef(null);
  const match=step.match(/(\d+)\s*(minuto|minutos|min|hora|horas|segundo|segundos)/i);
  if(!match)return null;
  let total=parseInt(match[1]);
  if(match[2].startsWith("hora"))total*=3600;
  else if(match[2].startsWith("min"))total*=60;
  const left=total-seconds;
  const pct=Math.min((seconds/total)*100,100);
  useEffect(()=>{
    if(running&&left>0){ref.current=setInterval(()=>setSeconds(s=>s+1),1000);}
    else if(left<=0){clearInterval(ref.current);setDone(true);setRunning(false);}
    return()=>clearInterval(ref.current);
  },[running,left]);
  const fmt=s=>`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
  return(
    <div style={{background:C.greenFaint,border:`1px solid ${C.border}`,borderRadius:"8px",padding:"8px 12px",marginTop:"6px",display:"flex",alignItems:"center",gap:"10px"}}>
      <div style={{flex:1}}>
        <div style={{fontSize:"0.7rem",color:C.textDim,marginBottom:"4px"}}>⏱ {fmt(left>0?left:0)}</div>
        <div style={{background:C.border,borderRadius:"4px",height:"4px",overflow:"hidden"}}>
          <div style={{background:done?C.accent:C.green,height:"100%",width:`${pct}%`,transition:"width 1s linear"}}/>
        </div>
      </div>
      {!done?(
        <button onClick={()=>setRunning(r=>!r)} style={{background:running?C.accentDim:C.borderLight,border:"none",borderRadius:"6px",color:running?C.accent:C.green,cursor:"pointer",fontSize:"0.75rem",padding:"4px 10px",fontFamily:"Georgia,serif"}}>
          {running?"⏸ Pausa":"▶ Iniciar"}
        </button>
      ):(
        <span style={{fontSize:"0.75rem",color:C.accent}}>✅ Listo</span>
      )}
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({C}) {
  const [loading, setLoading] = useState(false);
  const login = async () => {
    setLoading(true);
    try { await signInWithPopup(auth, googleProvider); }
    catch(e) { toast("⚠️ Error al iniciar sesión. Intenta de nuevo."); }
    finally { setLoading(false); }
  };
  return(
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"20px",fontFamily:"Georgia,serif"}}>
      <div style={{fontSize:"4rem",marginBottom:"16px"}}>🍳</div>
      <h1 style={{fontSize:"2rem",fontWeight:"bold",color:C.green,margin:"0 0 8px"}}>Chefify</h1>
      <p style={{fontSize:"0.9rem",color:C.textMuted,marginBottom:"40px",textAlign:"center"}}>Recetas para todos los mexicanos 🇲🇽</p>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"20px",padding:"32px 24px",width:"100%",maxWidth:"340px",textAlign:"center"}}>
        <div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.text,marginBottom:"8px"}}>Bienvenido</div>
        <p style={{fontSize:"0.82rem",color:C.textMuted,marginBottom:"24px",lineHeight:"1.5"}}>Inicia sesión para guardar tus recetas, favoritos e historial en todos tus dispositivos</p>
        <button onClick={login} disabled={loading} style={{width:"100%",background:"#fff",border:"1px solid #ddd",borderRadius:"12px",padding:"14px",display:"flex",alignItems:"center",justifyContent:"center",gap:"12px",cursor:"pointer",fontSize:"0.95rem",fontWeight:"bold",color:"#333",fontFamily:"Georgia,serif"}}>
          <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
          {loading ? "Iniciando sesión..." : "Continuar con Google"}
        </button>
        <p style={{fontSize:"0.72rem",color:C.textDim,marginTop:"16px"}}>Al continuar aceptas nuestros términos de uso</p>
      </div>
    </div>
  );
}

// ─── RECIPE OPTIONS ───────────────────────────────────────────────────────────
function RecipeOptions({options,onSelect,onBack,C}) {
  const [loadingIdx,setLoadingIdx]=useState(null);
  return(
    <div style={{maxWidth:"600px",margin:"0 auto",padding:"20px 16px"}}>
      <div style={{marginBottom:"20px"}}>
        <div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.green,marginBottom:"4px"}}>¿Cuál te late? 🍽</div>
        <div style={{fontSize:"0.8rem",color:C.textMuted}}>Elige la receta que más se te antoje</div>
      </div>
      {options.map((opt,i)=>(
        <div key={i} style={{background:C.card,border:`1px solid ${loadingIdx===i?C.green:C.border}`,borderRadius:"14px",padding:"16px 18px",marginBottom:"12px",cursor:loadingIdx!==null?"not-allowed":"pointer",opacity:loadingIdx!==null&&loadingIdx!==i?0.5:1}}
          onClick={async()=>{if(loadingIdx!==null)return;setLoadingIdx(i);await onSelect(opt);setLoadingIdx(null);}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"6px"}}>
            <div style={{fontSize:"1rem",fontWeight:"bold",color:C.text,flex:1}}>{opt.nombre}</div>
            {loadingIdx===i&&<span style={{fontSize:"0.75rem",color:C.green}}>Generando...</span>}
          </div>
          <div style={{fontSize:"0.82rem",color:C.textMuted,marginBottom:"10px",lineHeight:"1.4"}}>{opt.descripcion}</div>
          <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
            <span style={{fontSize:"0.72rem",color:C.textDim,background:C.bg,borderRadius:"5px",padding:"2px 8px"}}>⏱ {opt.tiempo}</span>
            <span style={{fontSize:"0.72rem",color:C.textDim,background:C.bg,borderRadius:"5px",padding:"2px 8px"}}>📊 {opt.dificultad}</span>
          </div>
        </div>
      ))}
      <button style={{width:"100%",background:"transparent",border:`1px solid ${C.border}`,borderRadius:"12px",color:C.textDim,cursor:"pointer",fontSize:"0.88rem",padding:"11px",fontFamily:"Georgia,serif",marginTop:"4px"}} onClick={onBack}>↩ Volver</button>
    </div>
  );
}

// ─── RECIPE CARD ─────────────────────────────────────────────────────────────
function RecipeCard({recipe,onReset,isPremium,onSaveFavorite,isFavorite,onAddToList,C}) {
  const [copied,setCopied]=useState(false);
  const [addedToList,setAddedToList]=useState(false);
  const [imgUrl,setImgUrl]=useState(null);
  const [imgLoading,setImgLoading]=useState(true);

  useEffect(()=>{
    if(recipe.nombre){
      fetchFoodImage(recipe.nombre).then(url=>{setImgUrl(url);setImgLoading(false);});
    }
  },[recipe.nombre]);

  const share=()=>{
    const text=`🍳 *${recipe.nombre}* — Chefify\n\nIngredientes: ${recipe.ingredientes?.join(", ")}\n\nhttps://chefify-phi.vercel.app`;
    navigator.clipboard?.writeText(text);
    setCopied(true);toast("✅ Receta copiada para compartir");setTimeout(()=>setCopied(false),2000);
  };

  const addToList=()=>{
    onAddToList(recipe.ingredientes_faltantes?.length>0?recipe.ingredientes_faltantes:recipe.ingredientes);
    setAddedToList(true);toast("🛒 Ingredientes agregados a tu lista");
  };

  const aBtn={background:C.greenFaint,border:`1px solid ${C.border}`,borderRadius:"8px",color:C.textMuted,cursor:"pointer",fontSize:"0.75rem",padding:"6px 12px",fontFamily:"Georgia,serif",display:"flex",alignItems:"center",gap:"5px"};
  const aBtnA={...aBtn,background:C.borderLight,border:`1px solid ${C.green}`,color:C.green};

  return(<>
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"16px",overflow:"hidden",marginBottom:"16px"}}>
      <div style={{width:"100%",height:"200px",background:C.greenFaint,overflow:"hidden",position:"relative"}}>
        {imgLoading&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"2rem",color:C.textDim}}>⏳</div>}
        {imgUrl?(
          <img src={imgUrl} alt={recipe.nombre} style={{width:"100%",height:"100%",objectFit:"cover",display:imgLoading?"none":"block"}} onLoad={()=>setImgLoading(false)} onError={()=>{setImgUrl(null);setImgLoading(false);}}/>
        ):(
          !imgLoading&&<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"3.5rem"}}>🍳</div>
        )}
      </div>
      <div style={{padding:"20px"}}>
        <div style={{fontSize:"1.3rem",fontWeight:"bold",color:C.green,marginBottom:"6px"}}>{recipe.nombre}</div>
        <div style={{display:"flex",gap:"8px",flexWrap:"wrap",marginBottom:"12px"}}>
          {recipe.tiempo&&<span style={{fontSize:"0.73rem",color:C.textMuted,background:C.bg,borderRadius:"6px",padding:"3px 9px"}}>⏱ {recipe.tiempo}</span>}
          {recipe.personas&&<span style={{fontSize:"0.73rem",color:C.textMuted,background:C.bg,borderRadius:"6px",padding:"3px 9px"}}>👥 {recipe.personas}</span>}
          {recipe.dificultad&&<span style={{fontSize:"0.73rem",color:C.textMuted,background:C.bg,borderRadius:"6px",padding:"3px 9px"}}>📊 {recipe.dificultad}</span>}
          {recipe.cocina&&<span style={{fontSize:"0.73rem",color:C.textMuted,background:C.bg,borderRadius:"6px",padding:"3px 9px"}}>{recipe.cocina}</span>}
          {isPremium&&recipe.calorias&&<span style={{fontSize:"0.73rem",color:C.gold,background:C.goldDim,borderRadius:"6px",padding:"3px 9px"}}>🔥 {recipe.calorias}</span>}
        </div>
        <div style={{display:"flex",gap:"8px",marginBottom:"16px",flexWrap:"wrap"}}>
          <button style={isFavorite?aBtnA:aBtn} onClick={()=>{onSaveFavorite(recipe);toast(isFavorite?"💔 Quitado de favoritos":"⭐ Guardado en favoritos");}}>
            {isFavorite?"⭐":"☆"} {isFavorite?"Guardado":"Guardar"}
          </button>
          <button style={addedToList?aBtnA:aBtn} onClick={addToList} disabled={addedToList}>
            🛒 {addedToList?"En lista":"A la lista"}
          </button>
          <button style={copied?aBtnA:aBtn} onClick={share}>{copied?"✅":"🔗"} {copied?"Copiado":"Compartir"}</button>
        </div>
        {isPremium&&recipe.macros&&(
          <div style={{background:C.goldDim,border:`1px solid ${C.gold}30`,borderRadius:"10px",padding:"12px",marginBottom:"12px"}}>
            <div style={{fontSize:"0.7rem",color:C.gold,fontWeight:"bold",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:"8px"}}>Macros por porción</div>
            <div style={{display:"flex",gap:"16px",flexWrap:"wrap"}}>
              {Object.entries(recipe.macros).map(([k,v])=>(
                <div key={k} style={{textAlign:"center"}}>
                  <div style={{fontSize:"1rem",fontWeight:"bold",color:C.gold}}>{v}</div>
                  <div style={{fontSize:"0.7rem",color:C.gold+"aa"}}>{k}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{fontSize:"0.7rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",margin:"16px 0 8px"}}>Ingredientes</div>
        {recipe.ingredientes?.map((ing,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:"10px",padding:"5px 0",borderBottom:`1px solid ${C.surface||C.bg}`,fontSize:"0.87rem",color:C.text}}>
            <div style={{width:"5px",height:"5px",borderRadius:"50%",background:C.borderLight,flexShrink:0}}/>
            {ing}
          </div>
        ))}
        {recipe.ingredientes_faltantes?.length>0&&(
          <div style={{background:C.accentDim,border:`1px solid ${C.accent}30`,borderRadius:"10px",padding:"12px 14px",marginTop:"14px"}}>
            <div style={{fontSize:"0.72rem",color:C.accent,fontWeight:"bold",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:"6px"}}>🛒 Necesitas comprar</div>
            {recipe.ingredientes_faltantes.map((ing,i)=><div key={i} style={{fontSize:"0.83rem",color:C.text,padding:"2px 0"}}>• {ing}</div>)}
          </div>
        )}
        <div style={{fontSize:"0.7rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",margin:"16px 0 8px"}}>Preparación</div>
        {recipe.pasos?.map((paso,i)=>(
          <div key={i} style={{padding:"9px 0",borderBottom:`1px solid ${C.surface||C.bg}`}}>
            <div style={{display:"flex",gap:"12px"}}>
              <div style={{width:"22px",height:"22px",borderRadius:"50%",background:C.borderLight,color:C.green,fontSize:"0.7rem",fontWeight:"bold",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:"2px"}}>{i+1}</div>
              <div style={{fontSize:"0.87rem",color:C.text,lineHeight:"1.5"}}>{paso}</div>
            </div>
            <div style={{paddingLeft:"34px"}}><StepTimer step={paso} C={C}/></div>
          </div>
        ))}
        {recipe.tip&&<div style={{background:C.greenFaint,borderLeft:`3px solid ${C.borderLight}`,borderRadius:"0 8px 8px 0",color:C.textMuted,fontSize:"0.82rem",marginTop:"14px",padding:"10px 14px",lineHeight:"1.5"}}>💡 <strong>Tip:</strong> {recipe.tip}</div>}
      </div>
    </div>
    <button style={{width:"100%",background:"transparent",border:`1px solid ${C.border}`,borderRadius:"12px",color:C.textDim,cursor:"pointer",fontSize:"0.88rem",padding:"11px",fontFamily:"Georgia,serif",marginTop:"4px"}} onClick={onReset}>↩ Volver</button>
  </>);
}

// ─── RECIPE UTILS ─────────────────────────────────────────────────────────────
function useRecipeUtils(uid) {
  const [favorites,setFavorites]=useState([]);
  const [history,setHistory]=useState([]);

  useEffect(()=>{
    if(!uid)return;
    (async()=>{
      const f = await loadFromFirestore(uid, "favorites");
      if(f) setFavorites(f);
      const h = await loadFromFirestore(uid, "history");
      if(h) setHistory(h);
    })();
  },[uid]);

  const saveFavorite=async(recipe)=>{
    const exists=favorites.find(f=>f.nombre===recipe.nombre);
    const nf=exists?favorites.filter(f=>f.nombre!==recipe.nombre):[recipe,...favorites].slice(0,50);
    setFavorites(nf);
    if(uid) await saveToFirestore(uid,"favorites",nf);
  };

  const addToHistory=async(recipe)=>{
    const nh=[{...recipe,viewedAt:Date.now()},...history.filter(h=>h.nombre!==recipe.nombre)].slice(0,30);
    setHistory(nh);
    if(uid) await saveToFirestore(uid,"history",nh);
  };

  const isFavorite=r=>favorites.some(f=>f.nombre===r.nombre);
  return{favorites,history,saveFavorite,addToHistory,isFavorite};
}

// ─── MODO REFRI ──────────────────────────────────────────────────────────────
function ModoRefri({profile,isPremium,recipeUtils,onAddToList,C}) {
  const [input,setInput]=useState("");
  const [ingredients,setIngredients]=useState([]);
  const [meal,setMeal]=useState("Cualquiera");
  const [diff,setDiff]=useState("Fácil");
  const [time,setTime]=useState("Sin límite");
  const [persons,setPersons]=useState("2 personas");
  const [cuisine,setCuisine]=useState("Cualquiera");
  const [loading,setLoading]=useState(false);
  const [options,setOptions]=useState(null);
  const [recipe,setRecipe]=useState(null);
  const [error,setError]=useState(null);
  const [listening,setListening]=useState(false);
  const [cameraOpen,setCameraOpen]=useState(false);
  const [photoPreview,setPhotoPreview]=useState(null);
  const [scanningPhoto,setScanningPhoto]=useState(false);
  const videoRef=useRef(null);
  const streamRef=useRef(null);
  const {canGenerate,remaining,increment}=useDailyLimit(isPremium);

  const addIngredients=(text)=>{
    const parts=text.split(/[,،\n]+/).map(p=>p.trim()).filter(p=>p.length>1);
    setIngredients(prev=>[...prev,...parts.filter(p=>!prev.includes(p))]);
  };
  const add=()=>{if(input.trim())addIngredients(input);setInput("");};

  const startListening=()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){toast("⚠️ Tu navegador no soporta voz");return;}
    const r=new SR();r.lang="es-MX";r.continuous=false;r.interimResults=false;
    r.onstart=()=>setListening(true);
    r.onresult=(e)=>{const t=e.results[0][0].transcript;toast(`🎤 Escuché: "${t}"`);addIngredients(t);};
    r.onerror=()=>toast("⚠️ No te escuché, intenta de nuevo");
    r.onend=()=>setListening(false);
    r.start();
  };

  const openCamera=async()=>{
    setCameraOpen(true);setPhotoPreview(null);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
      streamRef.current=stream;
      if(videoRef.current)videoRef.current.srcObject=stream;
    }catch{toast("⚠️ No se pudo acceder a la cámara");setCameraOpen(false);}
  };
  const closeCamera=()=>{streamRef.current?.getTracks().forEach(t=>t.stop());setCameraOpen(false);setPhotoPreview(null);};
  const takePhoto=()=>{
    const v=videoRef.current;if(!v)return;
    const c=document.createElement("canvas");c.width=v.videoWidth;c.height=v.videoHeight;
    c.getContext("2d").drawImage(v,0,0);
    setPhotoPreview(c.toDataURL("image/jpeg",0.8));
    streamRef.current?.getTracks().forEach(t=>t.stop());
  };
  const scanPhoto=async()=>{
    if(!photoPreview)return;setScanningPhoto(true);
    try{
      const base64=photoPreview.split(",")[1];
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",headers:{"Content-Type":"application/json","x-api-key":import.meta.env.VITE_ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:400,messages:[{role:"user",content:[
          {type:"image",source:{type:"base64",media_type:"image/jpeg",data:base64}},
          {type:"text",text:"Identifica todos los ingredientes o alimentos en esta imagen. Responde SOLO con una lista separada por comas en español, sin explicaciones."}
        ]}]})
      });
      const data=await res.json();
      const text=data.content?.map(b=>b.text||"").join("")||"";
      const found=text.split(",").map(s=>s.trim()).filter(s=>s.length>1);
      if(found.length>0){setIngredients(prev=>[...prev,...found.filter(f=>!prev.includes(f))]);toast(`📷 Detecté ${found.length} ingredientes`);setCameraOpen(false);setPhotoPreview(null);}
      else toast("⚠️ No detecté ingredientes, intenta de nuevo");
    }catch{toast("⚠️ Error al analizar la foto");}
    finally{setScanningPhoto(false);}
  };

  const generateOptions=async()=>{
    if(!ingredients.length)return;
    if(!canGenerate){toast("⚠️ Alcanzaste tu límite de 3 recetas hoy. ¡Activa Premium!");return;}
    setLoading(true);setOptions(null);setError(null);
    const ctx=buildProfileContext(profile);
    try{
      const r=await callAI(`Eres chef experto.${ctx} Ingredientes: ${ingredients.join(", ")}. Tipo: ${meal}. Dificultad: ${diff}. Tiempo: ${time}. Para: ${persons}. Cocina: ${cuisine.replace(/[^\w\s]/g,"").trim()}.
Dame 3 opciones de recetas. Responde SOLO JSON sin backticks:
{"opciones":[{"nombre":"","descripcion":"1 línea","tiempo":"X min","dificultad":""}]}`);
      setOptions(r.opciones||[]);
    }catch{setError("No se pudieron generar las opciones. Intenta de nuevo.");}
    finally{setLoading(false);}
  };

  const selectOption=async(opt)=>{
    setOptions(null);
    setLoading(true);
    setError(null);
    const ctx=buildProfileContext(profile);
    const macrosField=isPremium?`"calorias":"X kcal por porción","macros":{"Proteína":"Xg","Carbos":"Xg","Grasa":"Xg"},`:"";
    try{
      const r=await callAI(`Eres chef experto.${ctx} Receta completa de: "${opt.nombre}". Usa: ${ingredients.join(", ")}. Para: ${persons}.
Responde SOLO JSON sin backticks: {"nombre":"","tiempo":"","porciones":"${persons}","personas":"${persons}","dificultad":"${opt.dificultad}","cocina":"",${macrosField}"ingredientes":[],"ingredientes_faltantes":[],"pasos":[],"tip":""}`);
      setRecipe(r);
      recipeUtils.addToHistory(r);
      increment();
    }catch{setError("No se pudo generar la receta. Intenta de nuevo.");}
    finally{setLoading(false);}
  };

  const reset=()=>{setRecipe(null);setOptions(null);setError(null);};
  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};
  const inp={flex:1,background:C.inputBg,border:`1px solid ${C.border}`,borderRadius:"10px",color:C.text,fontSize:"0.95rem",padding:"11px 14px",outline:"none",fontFamily:"Georgia,serif"};

  if(recipe)return<div style={main}><RecipeCard recipe={recipe} onReset={reset} isPremium={isPremium} onSaveFavorite={recipeUtils.saveFavorite} isFavorite={recipeUtils.isFavorite(recipe)} onAddToList={onAddToList} C={C}/></div>;
  if(options)return<RecipeOptions options={options} onSelect={selectOption} onBack={()=>setOptions(null)} C={C}/>;
  if(loading)return<div style={{...main,textAlign:"center",paddingTop:"60px"}}><div style={{fontSize:"2.5rem",marginBottom:"12px"}}>👨‍🍳</div><p style={{color:C.textMuted}}>El chef está pensando...</p></div>;

  if(cameraOpen)return(
    <div style={main}>
      <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"16px"}}>
        <button style={{background:"none",border:"none",color:C.textMuted,cursor:"pointer",fontSize:"1rem"}} onClick={closeCamera}>← Cancelar</button>
        <div style={{flex:1,fontSize:"0.95rem",fontWeight:"bold",color:C.green}}>📷 Foto de ingredientes</div>
      </div>
      {!photoPreview?(
        <>
          <div style={{background:"#000",borderRadius:"14px",overflow:"hidden",marginBottom:"16px",position:"relative"}}>
            <video ref={el=>{videoRef.current=el;if(el&&streamRef.current)el.srcObject=streamRef.current;}} autoPlay playsInline style={{width:"100%",display:"block",maxHeight:"340px",objectFit:"cover"}}/>
            <div style={{position:"absolute",bottom:"16px",left:0,right:0,textAlign:"center"}}>
              <button onClick={takePhoto} style={{background:C.green,border:"4px solid #fff",borderRadius:"50%",width:"64px",height:"64px",cursor:"pointer",fontSize:"1.8rem"}}>📷</button>
            </div>
          </div>
          <p style={{textAlign:"center",color:C.textMuted,fontSize:"0.82rem"}}>Apunta al refri o a tus ingredientes</p>
        </>
      ):(
        <>
          <img src={photoPreview} style={{width:"100%",borderRadius:"14px",marginBottom:"16px",maxHeight:"340px",objectFit:"cover"}} alt="foto"/>
          <div style={{display:"flex",gap:"10px"}}>
            <button style={{flex:1,background:"transparent",border:`1px solid ${C.borderLight}`,borderRadius:"10px",color:C.green,cursor:"pointer",padding:"12px",fontFamily:"Georgia,serif"}} onClick={()=>setPhotoPreview(null)}>↩ Repetir</button>
            <button style={{flex:2,background:`linear-gradient(135deg,#3a7a3a,#2d5a2d)`,border:"none",borderRadius:"10px",color:C.text,cursor:"pointer",fontWeight:"bold",padding:"12px",fontFamily:"Georgia,serif"}} onClick={scanPhoto} disabled={scanningPhoto}>
              {scanningPhoto?"Analizando...":"🔍 Detectar ingredientes"}
            </button>
          </div>
        </>
      )}
    </div>
  );

  return(
    <div style={main}>
      {!isPremium&&(
        <div style={{background:C.greenFaint,border:`1px solid ${C.borderLight}`,borderRadius:"10px",padding:"10px 14px",marginBottom:"16px",fontSize:"0.78rem",color:C.textMuted,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span>🍳 Recetas gratis hoy: <strong style={{color:C.green}}>{remaining}/{DAILY_LIMIT}</strong></span>
          {remaining===0&&<span style={{color:C.accent,fontSize:"0.72rem"}}>¡Activa Premium!</span>}
        </div>
      )}
      {profile.restrictions?.length>0&&(
        <div style={{background:C.greenFaint,border:`1px solid ${C.borderLight}`,borderRadius:"10px",padding:"10px 14px",marginBottom:"16px",fontSize:"0.78rem",color:C.textMuted}}>
          ✅ Perfil aplicado: {profile.restrictions.join(", ")}{profile.allergies?.length>0&&` • Sin: ${profile.allergies.join(", ")}`}
        </div>
      )}
      <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px"}}>¿Qué tienes en tu refri o alacena?</span>
      <div style={{display:"flex",gap:"8px"}}>
        <input style={inp} placeholder="Ej: huevos, jitomate, queso..." value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()}/>
        <button style={{background:listening?"#3a1010":C.borderLight,border:listening?`1px solid ${C.accent}`:"none",borderRadius:"10px",color:listening?C.accent:C.green,cursor:"pointer",fontSize:"1.2rem",padding:"0 11px"}} onClick={startListening}>{listening?"🔴":"🎤"}</button>
        <button style={{background:C.borderLight,border:"none",borderRadius:"10px",color:C.green,cursor:"pointer",fontSize:"1.2rem",padding:"0 11px"}} onClick={openCamera}>📷</button>
        <button style={{background:C.borderLight,border:"none",borderRadius:"10px",color:C.green,cursor:"pointer",fontSize:"1.4rem",padding:"0 13px"}} onClick={add}>+</button>
      </div>
      {listening&&<div style={{background:C.accentDim,border:`1px solid ${C.accent}`,borderRadius:"10px",padding:"10px",marginTop:"8px",fontSize:"0.8rem",color:C.accent,textAlign:"center"}}>🔴 Escuchando... habla ahora</div>}
      <div style={{display:"flex",flexWrap:"wrap",gap:"7px",marginTop:"10px",minHeight:"30px"}}>
        {!ingredients.length&&<span style={{color:C.textDim,fontSize:"0.8rem",alignSelf:"center"}}>Agrega al menos un ingrediente</span>}
        {ingredients.map((ing,i)=>(
          <span key={i} style={{background:C.greenFaint,border:`1px solid ${C.borderLight}`,borderRadius:"20px",color:C.textMuted,fontSize:"0.8rem",padding:"4px 12px",display:"flex",alignItems:"center",gap:"7px"}}>
            {ing}<button style={{background:"none",border:"none",color:C.textDim,cursor:"pointer",fontSize:"0.85rem",padding:"0"}} onClick={()=>setIngredients(ingredients.filter((_,idx)=>idx!==i))}>✕</button>
          </span>
        ))}
      </div>
      <FilterChips label="¿Para cuántas personas?" options={PERSONS} value={persons} onChange={setPersons} C={C}/>
      <FilterChips label="Tipo de comida" options={MEAL_TYPES} value={meal} onChange={setMeal} C={C}/>
      <FilterChips label="Cocina" options={CUISINES} value={cuisine} onChange={setCuisine} C={C}/>
      <FilterChips label="Dificultad" options={DIFFICULTIES} value={diff} onChange={setDiff} C={C}/>
      <FilterChips label="Tiempo disponible" options={TIMES} value={time} onChange={setTime} C={C}/>
      <button style={{width:"100%",background:!ingredients.length?C.greenFaint:`linear-gradient(135deg,#3a7a3a,#2d5a2d)`,border:!ingredients.length?`1px solid ${C.border}`:"none",borderRadius:"12px",color:!ingredients.length?C.textDim:C.text,cursor:!ingredients.length?"not-allowed":"pointer",fontSize:"1rem",fontWeight:"bold",padding:"15px",fontFamily:"Georgia,serif",marginTop:"20px",marginBottom:"24px"}} onClick={generateOptions} disabled={!ingredients.length}>
        🍳 ¡Ver opciones de recetas!
      </button>
      {error&&<div style={{background:C.accentDim,border:`1px solid ${C.accent}30`,borderRadius:"12px",color:C.accent,padding:"14px",textAlign:"center",fontSize:"0.88rem"}}>{error}</div>}
    </div>
  );
}

// ─── MODO BUSCAR ─────────────────────────────────────────────────────────────
function ModoBuscar({profile,isPremium,recipeUtils,onAddToList,C}) {
  const [query,setQuery]=useState("");
  const [diff,setDiff]=useState("Fácil");
  const [time,setTime]=useState("Sin límite");
  const [persons,setPersons]=useState("2 personas");
  const [cuisine,setCuisine]=useState("Cualquiera");
  const [loading,setLoading]=useState(false);
  const [options,setOptions]=useState(null);
  const [recipe,setRecipe]=useState(null);
  const [error,setError]=useState(null);
  const {canGenerate,remaining,increment}=useDailyLimit(isPremium);

  const searchOptions=async()=>{
    if(!query.trim())return;
    if(!canGenerate){toast("⚠️ Alcanzaste tu límite de 3 recetas hoy. ¡Activa Premium!");return;}
    setLoading(true);setOptions(null);setError(null);
    const ctx=buildProfileContext(profile);
    try{
      const r=await callAI(`Eres chef experto.${ctx} El usuario quiere: "${query}". Dificultad: ${diff}. Tiempo: ${time}. Cocina: ${cuisine.replace(/[^\w\s]/g,"").trim()}.
Dame 3 opciones de recetas. Responde SOLO JSON sin backticks:
{"opciones":[{"nombre":"","descripcion":"1 línea","tiempo":"X min","dificultad":""}]}`);
      setOptions(r.opciones||[]);
    }catch{setError("No se encontraron opciones.");}
    finally{setLoading(false);}
  };

  const selectOption=async(opt)=>{
    setOptions(null);
    setLoading(true);
    setError(null);
    const ctx=buildProfileContext(profile);
    const macrosField=isPremium?`"calorias":"X kcal por porción","macros":{"Proteína":"Xg","Carbos":"Xg","Grasa":"Xg"},`:"";
    try{
      const r=await callAI(`Eres chef experto.${ctx} Receta completa de: "${opt.nombre}". Para: ${persons}.
Responde SOLO JSON sin backticks: {"nombre":"","tiempo":"","porciones":"${persons}","personas":"${persons}","dificultad":"${opt.dificultad}","cocina":"",${macrosField}"ingredientes":[],"ingredientes_faltantes":[],"pasos":[],"tip":""}`);
      setRecipe(r);
      recipeUtils.addToHistory(r);
      increment();
    }catch{setError("No se pudo generar la receta.");}
    finally{setLoading(false);}
  };

  const reset=()=>{setRecipe(null);setOptions(null);setError(null);};
  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};
  const inp={width:"100%",background:C.inputBg,border:`1px solid ${C.border}`,borderRadius:"10px",color:C.text,fontSize:"0.95rem",padding:"11px 14px",outline:"none",fontFamily:"Georgia,serif",boxSizing:"border-box"};

  if(recipe)return<div style={main}><RecipeCard recipe={recipe} onReset={reset} isPremium={isPremium} onSaveFavorite={recipeUtils.saveFavorite} isFavorite={recipeUtils.isFavorite(recipe)} onAddToList={onAddToList} C={C}/></div>;
  if(options)return<RecipeOptions options={options} onSelect={selectOption} onBack={()=>setOptions(null)} C={C}/>;
  if(loading)return<div style={{...main,textAlign:"center",paddingTop:"60px"}}><div style={{fontSize:"2.5rem",marginBottom:"12px"}}>📖</div><p style={{color:C.textMuted}}>Buscando recetas...</p></div>;

  return(
    <div style={main}>
      {!isPremium&&(
        <div style={{background:C.greenFaint,border:`1px solid ${C.borderLight}`,borderRadius:"10px",padding:"10px 14px",marginBottom:"16px",fontSize:"0.78rem",color:C.textMuted,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span>🍳 Recetas gratis hoy: <strong style={{color:C.green}}>{remaining}/{DAILY_LIMIT}</strong></span>
          {remaining===0&&<span style={{color:C.accent,fontSize:"0.72rem"}}>¡Activa Premium!</span>}
        </div>
      )}
      <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px"}}>¿Qué quieres cocinar?</span>
      <input style={inp} placeholder="Ej: sushi, pozole, pasta carbonara..." value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&searchOptions()}/>
      <p style={{fontSize:"0.8rem",color:C.textDim,marginTop:"10px"}}>Escribe cualquier platillo del mundo 🌍</p>
      <FilterChips label="¿Para cuántas personas?" options={PERSONS} value={persons} onChange={setPersons} C={C}/>
      <FilterChips label="Cocina" options={CUISINES} value={cuisine} onChange={setCuisine} C={C}/>
      <FilterChips label="Dificultad" options={DIFFICULTIES} value={diff} onChange={setDiff} C={C}/>
      <FilterChips label="Tiempo disponible" options={TIMES} value={time} onChange={setTime} C={C}/>
      <button style={{width:"100%",background:!query.trim()?C.greenFaint:`linear-gradient(135deg,#3a7a3a,#2d5a2d)`,border:!query.trim()?`1px solid ${C.border}`:"none",borderRadius:"12px",color:!query.trim()?C.textDim:C.text,cursor:!query.trim()?"not-allowed":"pointer",fontSize:"1rem",fontWeight:"bold",padding:"15px",fontFamily:"Georgia,serif",marginTop:"20px",marginBottom:"24px"}} onClick={searchOptions} disabled={!query.trim()}>
        🔍 Ver opciones de recetas
      </button>
      {error&&<div style={{background:C.accentDim,borderRadius:"12px",color:C.accent,padding:"14px",textAlign:"center",fontSize:"0.88rem"}}>{error}</div>}
    </div>
  );
}

// ─── MODO TRENDING ───────────────────────────────────────────────────────────
function ModoTrending({profile,isPremium,recipeUtils,onAddToList,C}) {
  const [trending,setTrending]=useState([]);
  const [loading,setLoading]=useState(true);
  const [recipe,setRecipe]=useState(null);
  const [loadingRecipe,setLoadingRecipe]=useState(false);
  const [error,setError]=useState(null);

  useEffect(()=>{
    (async()=>{
      const ctx=buildProfileContext(profile);
      try{
        const r=await callAI(`Eres experto en tendencias gastronómicas.${ctx} Dame 6 recetas trending en redes sociales. Mezcla mexicanas e internacionales.
Responde SOLO JSON sin backticks: {"recetas":[{"nombre":"","emoji":"","descripcion":"","tiempo":"","dificultad":"","cocina":"","razon_trending":""}]}`);
        setTrending(r.recetas||[]);
      }catch{setError("No se pudieron cargar las recetas trending.");}
      finally{setLoading(false);}
    })();
  },[]);

  const openRecipe=async(item)=>{
    setLoadingRecipe(true);setRecipe(null);
    const macrosField=isPremium?`"calorias":"X kcal por porción","macros":{"Proteína":"Xg","Carbos":"Xg","Grasa":"Xg"},`:"";
    try{
      const r=await callAI(`Eres chef experto. Receta completa de: "${item.nombre}".
Responde SOLO JSON sin backticks: {"nombre":"","tiempo":"","porciones":"2 personas","personas":"2 personas","dificultad":"${item.dificultad}","cocina":"${item.cocina}",${macrosField}"ingredientes":[],"ingredientes_faltantes":[],"pasos":[],"tip":""}`);
      setRecipe(r);recipeUtils.addToHistory(r);
    }catch{setError("No se pudo cargar la receta.");}
    finally{setLoadingRecipe(false);}
  };

  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};
  if(recipe)return<div style={main}><RecipeCard recipe={recipe} onReset={()=>setRecipe(null)} isPremium={isPremium} onSaveFavorite={recipeUtils.saveFavorite} isFavorite={recipeUtils.isFavorite(recipe)} onAddToList={onAddToList} C={C}/></div>;
  return(
    <div style={main}>
      <div style={{marginBottom:"20px"}}>
        <div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.green,marginBottom:"4px"}}>🔥 Recetas Trending</div>
        <div style={{fontSize:"0.8rem",color:C.textMuted}}>Lo que todo el mundo está cocinando ahorita en redes</div>
      </div>
      {loading&&<div style={{textAlign:"center",padding:"36px 0",color:C.textMuted}}><div style={{fontSize:"2rem",marginBottom:"10px"}}>🔥</div><p style={{margin:0}}>Cargando lo más trendy...</p></div>}
      {loadingRecipe&&<div style={{textAlign:"center",padding:"36px 0",color:C.textMuted}}><div style={{fontSize:"2rem",marginBottom:"10px"}}>👨‍🍳</div><p style={{margin:0}}>Preparando la receta...</p></div>}
      {error&&<div style={{background:C.accentDim,borderRadius:"12px",color:C.accent,padding:"14px",textAlign:"center",fontSize:"0.88rem"}}>{error}</div>}
      {!loading&&!loadingRecipe&&trending.map((item,i)=>(
        <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"14px",padding:"16px 18px",marginBottom:"12px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"6px"}}>
            <div style={{fontSize:"1rem",fontWeight:"bold",color:C.text,flex:1}}>{item.emoji} {item.nombre}</div>
            <div style={{fontSize:"0.7rem",background:C.accentDim,color:C.accent,borderRadius:"6px",padding:"3px 8px",marginLeft:"10px"}}>🔥 Trending</div>
          </div>
          <div style={{fontSize:"0.8rem",color:C.textMuted,lineHeight:"1.4",marginBottom:"10px"}}>{item.descripcion}</div>
          <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
            <span style={{fontSize:"0.72rem",color:C.textDim,background:C.bg,borderRadius:"5px",padding:"2px 8px"}}>⏱ {item.tiempo}</span>
            <span style={{fontSize:"0.72rem",color:C.textDim,background:C.bg,borderRadius:"5px",padding:"2px 8px"}}>📊 {item.dificultad}</span>
            <span style={{fontSize:"0.72rem",color:C.textDim,background:C.bg,borderRadius:"5px",padding:"2px 8px"}}>{item.cocina}</span>
          </div>
          <div style={{fontSize:"0.75rem",color:C.accent,marginTop:"8px"}}>📱 {item.razon_trending}</div>
          <button style={{marginTop:"10px",background:C.greenFaint,border:`1px solid ${C.borderLight}`,borderRadius:"8px",color:C.green,cursor:"pointer",fontSize:"0.78rem",padding:"6px 14px",fontFamily:"Georgia,serif"}} onClick={()=>openRecipe(item)}>Ver receta completa →</button>
        </div>
      ))}
    </div>
  );
}

// ─── FAVORITOS ───────────────────────────────────────────────────────────────
function ModoFavoritos({favorites,isPremium,recipeUtils,onAddToList,C}) {
  const [selected,setSelected]=useState(null);
  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};
  if(selected)return<div style={main}><RecipeCard recipe={selected} onReset={()=>setSelected(null)} isPremium={isPremium} onSaveFavorite={recipeUtils.saveFavorite} isFavorite={recipeUtils.isFavorite(selected)} onAddToList={onAddToList} C={C}/></div>;
  return(
    <div style={main}>
      <div style={{marginBottom:"20px"}}>
        <div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.green,marginBottom:"4px"}}>⭐ Mis Favoritos</div>
        <div style={{fontSize:"0.8rem",color:C.textMuted}}>Recetas que guardaste para volver a hacer</div>
      </div>
      {favorites.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:C.textDim}}><div style={{fontSize:"2.5rem",marginBottom:"12px"}}>⭐</div><div style={{fontSize:"0.88rem"}}>Todavía no tienes favoritos</div></div>}
      {favorites.map((r,i)=>(
        <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"14px",padding:"16px",marginBottom:"10px",display:"flex",gap:"12px",alignItems:"center",cursor:"pointer"}} onClick={()=>setSelected(r)}>
          <div style={{fontSize:"2rem"}}>🍳</div>
          <div style={{flex:1}}>
            <div style={{fontSize:"0.95rem",fontWeight:"bold",color:C.text}}>{r.nombre}</div>
            <div style={{fontSize:"0.72rem",color:C.textMuted,marginTop:"3px"}}>{r.tiempo} • {r.dificultad} • {r.personas||r.porciones}</div>
          </div>
          <span style={{color:C.textDim,fontSize:"0.8rem"}}>›</span>
        </div>
      ))}
    </div>
  );
}

// ─── HISTORIAL ───────────────────────────────────────────────────────────────
function ModoHistorial({history,isPremium,recipeUtils,onAddToList,C}) {
  const [selected,setSelected]=useState(null);
  const timeAgo=(ts)=>{const d=Date.now()-ts;if(d<3600000)return`hace ${Math.floor(d/60000)} min`;if(d<86400000)return`hace ${Math.floor(d/3600000)} h`;return`hace ${Math.floor(d/86400000)} días`;};
  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};
  if(selected)return<div style={main}><RecipeCard recipe={selected} onReset={()=>setSelected(null)} isPremium={isPremium} onSaveFavorite={recipeUtils.saveFavorite} isFavorite={recipeUtils.isFavorite(selected)} onAddToList={onAddToList} C={C}/></div>;
  return(
    <div style={main}>
      <div style={{marginBottom:"20px"}}>
        <div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.green,marginBottom:"4px"}}>📊 Historial</div>
        <div style={{fontSize:"0.8rem",color:C.textMuted}}>Recetas que has visto recientemente</div>
      </div>
      {history.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:C.textDim}}><div style={{fontSize:"2.5rem",marginBottom:"12px"}}>📊</div><div style={{fontSize:"0.88rem"}}>Tu historial está vacío</div></div>}
      {history.map((r,i)=>(
        <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"14px",padding:"14px 16px",marginBottom:"8px",display:"flex",gap:"10px",alignItems:"center",cursor:"pointer"}} onClick={()=>setSelected(r)}>
          <div style={{fontSize:"1.5rem"}}>🍳</div>
          <div style={{flex:1}}>
            <div style={{fontSize:"0.88rem",fontWeight:"bold",color:C.text}}>{r.nombre}</div>
            <div style={{fontSize:"0.7rem",color:C.textDim,marginTop:"2px"}}>{r.dificultad} • {r.tiempo} • {timeAgo(r.viewedAt)}</div>
          </div>
          <span style={{color:C.textDim,fontSize:"0.8rem"}}>›</span>
        </div>
      ))}
    </div>
  );
}

// ─── LISTA DEL SÚPER ─────────────────────────────────────────────────────────
function ModoLista({uid,profile,pendingItems,onClearPending,C}) {
  const [items,setItems]=useState([]);
  const [input,setInput]=useState("");
  const [author,setAuthor]=useState(profile.name||"Yo");
  const [listCode,setListCode]=useState("");
  const [joinCode,setJoinCode]=useState("");
  const [mode,setMode]=useState("home");
  const [saving,setSaving]=useState(false);
  const [myLists,setMyLists]=useState([]);

  useEffect(()=>{
    if(pendingItems?.length>0&&mode==="list"){
      pendingItems.forEach(t=>addDirect(t));
      onClearPending();
    }
  },[pendingItems,mode]);

  useEffect(()=>{
    if(!uid)return;
    (async()=>{
      const saved=await loadFromFirestore(uid,"myLists");
      if(saved)setMyLists(saved);
    })();
  },[uid]);

  const saveMyLists=async(lists)=>{
    setMyLists(lists);
    if(uid)await saveToFirestore(uid,"myLists",lists);
  };

  const genCode=()=>Math.random().toString(36).substring(2,7).toUpperCase();

  const saveListToFirestore=async(code,newItems)=>{
    setSaving(true);
    try{
      await setDoc(doc(db,"lists",code),{items:newItems,updatedAt:Date.now()},{merge:true});
    }catch{}
    setSaving(false);
  };

  const createList=async()=>{
    const code=genCode();
    await setDoc(doc(db,"lists",code),{code,items:[],createdBy:author,createdAt:Date.now()});
    const newLists=[{code,name:`Lista ${code}`,createdAt:Date.now()},...myLists].slice(0,10);
    await saveMyLists(newLists);
    setListCode(code);setItems([]);setMode("list");
  };

  const joinList=async()=>{
    const code=joinCode.toUpperCase().trim();
    try{
      const snap=await getDoc(doc(db,"lists",code));
      if(snap.exists()){
        setListCode(code);setItems(snap.data().items||[]);setMode("list");
        if(!myLists.find(l=>l.code===code)){
          const newLists=[{code,name:`Lista ${code}`,joinedAt:Date.now()},...myLists].slice(0,10);
          await saveMyLists(newLists);
        }
      } else alert("No se encontró esa lista.");
    }catch{alert("Error al unirse a la lista.");}
  };

  const openList=async(code)=>{
    try{
      const snap=await getDoc(doc(db,"lists",code));
      if(snap.exists()){setListCode(code);setItems(snap.data().items||[]);setMode("list");}
      else alert("Esta lista ya no existe.");
    }catch{alert("Error al abrir la lista.");}
  };

  const removeFromMyLists=async(code)=>{
    const newLists=myLists.filter(l=>l.code!==code);
    await saveMyLists(newLists);
  };

  const syncList=async()=>{
    try{
      const snap=await getDoc(doc(db,"lists",listCode));
      if(snap.exists())setItems(snap.data().items||[]);
    }catch{}
  };

  const addDirect=async(text)=>{
    setItems(prev=>{
      const ni=[...prev,{id:Date.now()+Math.random(),text,author:author||"Yo",done:false}];
      saveListToFirestore(listCode,ni);
      return ni;
    });
  };

  const addItem=async()=>{if(!input.trim())return;await addDirect(input.trim());setInput("");};

  const toggleItem=async(id)=>{
    const ni=items.map(it=>it.id===id?{...it,done:!it.done}:it);
    setItems(ni);await saveListToFirestore(listCode,ni);
  };

  const deleteItem=async(id)=>{
    const ni=items.filter(it=>it.id!==id);
    setItems(ni);await saveListToFirestore(listCode,ni);
  };

  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};
  const inp={flex:1,background:C.inputBg,border:`1px solid ${C.border}`,borderRadius:"10px",color:C.text,fontSize:"0.95rem",padding:"11px 14px",outline:"none",fontFamily:"Georgia,serif"};
  const btn={width:"100%",background:`linear-gradient(135deg,#3a7a3a,#2d5a2d)`,border:"none",borderRadius:"12px",color:"#e0ede0",cursor:"pointer",fontSize:"1rem",fontWeight:"bold",padding:"15px",fontFamily:"Georgia,serif",marginTop:"20px",marginBottom:"8px"};

  if(mode==="home")return(
    <div style={main}>
      <div style={{marginBottom:"20px"}}><div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.green,marginBottom:"4px"}}>📝 Lista del Súper</div><div style={{fontSize:"0.8rem",color:C.textMuted,lineHeight:"1.5"}}>Crea listas compartidas. Todos pueden agregar y tachar en tiempo real.</div></div>
      {myLists.length>0&&(
        <>
          <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px"}}>Mis listas</span>
          {myLists.map((l,i)=>(
            <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"12px",padding:"12px 16px",marginBottom:"8px",display:"flex",alignItems:"center",gap:"10px"}}>
              <div style={{flex:1,cursor:"pointer"}} onClick={()=>openList(l.code)}>
                <div style={{fontSize:"0.88rem",fontWeight:"bold",color:C.text}}>📝 {l.name}</div>
                <div style={{fontSize:"0.7rem",color:C.textDim,marginTop:"2px"}}>Código: {l.code}</div>
              </div>
              <button style={{background:"none",border:"none",color:C.green,cursor:"pointer",fontSize:"0.8rem",padding:"6px 12px",borderRadius:"8px",border:`1px solid ${C.borderLight}`}} onClick={()=>openList(l.code)}>Abrir →</button>
              <button style={{background:"none",border:"none",color:C.textDim,cursor:"pointer",fontSize:"0.9rem",padding:"4px"}} onClick={()=>removeFromMyLists(l.code)}>✕</button>
            </div>
          ))}
          <div style={{display:"flex",alignItems:"center",gap:"10px",margin:"16px 0",color:C.textDim,fontSize:"0.78rem"}}><div style={{flex:1,height:"1px",background:C.border}}/><span>nueva lista</span><div style={{flex:1,height:"1px",background:C.border}}/></div>
        </>
      )}
      <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px"}}>Tu nombre en la lista</span>
      <input style={{...inp,flex:"unset",width:"100%",boxSizing:"border-box"}} placeholder="Ej: Mamá, Juan..." value={author} onChange={e=>setAuthor(e.target.value)}/>
      <button style={btn} onClick={createList}>📝 Crear nueva lista</button>
      <div style={{display:"flex",alignItems:"center",gap:"10px",margin:"16px 0",color:C.textDim,fontSize:"0.78rem"}}><div style={{flex:1,height:"1px",background:C.border}}/><span>o</span><div style={{flex:1,height:"1px",background:C.border}}/></div>
      <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px"}}>Unirte a una lista</span>
      <input style={{...inp,flex:"unset",width:"100%",boxSizing:"border-box",textAlign:"center",letterSpacing:"0.15em",textTransform:"uppercase",fontSize:"1.2rem"}} placeholder="CÓDIGO" value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())} maxLength={5}/>
      <button style={{...btn,background:joinCode.length<5?C.greenFaint:"linear-gradient(135deg,#3a7a3a,#2d5a2d)",color:joinCode.length<5?C.textDim:"#e0ede0"}} onClick={joinList} disabled={joinCode.length<5}>Unirme a la lista</button>
    </div>
  );

  const pending=items.filter(it=>!it.done).length,done=items.filter(it=>it.done).length;
  return(
    <div style={main}>
      <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"16px"}}>
        <button style={{background:"none",border:"none",color:C.textMuted,cursor:"pointer",fontSize:"1rem"}} onClick={()=>setMode("home")}>←</button>
        <div style={{flex:1}}><div style={{fontSize:"1rem",fontWeight:"bold",color:C.green}}>📝 Lista compartida</div><div style={{fontSize:"0.72rem",color:C.textMuted}}>{pending} pendientes • {done} tachados</div></div>
        <button style={{background:C.borderLight,border:"none",borderRadius:"8px",color:C.green,cursor:"pointer",fontSize:"0.8rem",padding:"7px 14px",fontFamily:"Georgia,serif"}} onClick={syncList}>↻ Sync</button>
      </div>
      <div style={{background:C.greenFaint,border:`1px solid ${C.borderLight}`,borderRadius:"10px",padding:"14px",marginBottom:"20px",textAlign:"center"}}>
        <div style={{fontSize:"0.7rem",color:C.textMuted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:"6px"}}>Código para invitar</div>
        <div style={{fontSize:"1.6rem",fontWeight:"bold",color:C.green,letterSpacing:"0.2em"}}>{listCode}</div>
        <div style={{fontSize:"0.72rem",color:C.textDim,marginTop:"4px"}}>Comparte este código con quien quieras</div>
      </div>
      <div style={{display:"flex",gap:"8px"}}>
        <input style={inp} placeholder="Agregar producto..." value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addItem()}/>
        <button style={{background:C.borderLight,border:"none",borderRadius:"10px",color:C.green,cursor:"pointer",fontSize:"1.4rem",padding:"0 13px"}} onClick={addItem}>+</button>
      </div>
      {saving&&<div style={{fontSize:"0.72rem",color:C.textDim,textAlign:"right",marginTop:"6px"}}>Guardando...</div>}
      <div style={{marginTop:"16px"}}>
        {items.filter(it=>!it.done).map(item=>(
          <div key={item.id} style={{display:"flex",alignItems:"center",gap:"10px",padding:"11px 14px",background:C.card,border:`1px solid ${C.border}`,borderRadius:"10px",marginBottom:"8px"}}>
            <div style={{width:"20px",height:"20px",borderRadius:"50%",border:`2px solid ${C.borderLight}`,cursor:"pointer",flexShrink:0}} onClick={()=>toggleItem(item.id)}/>
            <div style={{flex:1}}><div style={{fontSize:"0.88rem",color:C.text}}>{item.text}</div><div style={{fontSize:"0.7rem",color:C.textDim}}>por {item.author}</div></div>
            <button style={{background:"none",border:"none",color:C.textDim,cursor:"pointer",fontSize:"0.9rem",padding:"0 4px"}} onClick={()=>deleteItem(item.id)}>✕</button>
          </div>
        ))}
        {items.filter(it=>it.done).map(item=>(
          <div key={item.id} style={{display:"flex",alignItems:"center",gap:"10px",padding:"11px 14px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",marginBottom:"8px",opacity:0.5}}>
            <div style={{width:"20px",height:"20px",borderRadius:"50%",border:`2px solid ${C.green}`,background:C.green,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.7rem"}} onClick={()=>toggleItem(item.id)}>✓</div>
            <div style={{flex:1}}><div style={{fontSize:"0.88rem",color:C.textDim,textDecoration:"line-through"}}>{item.text}</div><div style={{fontSize:"0.7rem",color:C.textDim}}>por {item.author}</div></div>
            <button style={{background:"none",border:"none",color:C.textDim,cursor:"pointer",fontSize:"0.9rem",padding:"0 4px"}} onClick={()=>deleteItem(item.id)}>✕</button>
          </div>
        ))}
        {items.length===0&&<div style={{textAlign:"center",color:C.textDim,fontSize:"0.85rem",padding:"30px 0"}}>La lista está vacía 🛒</div>}
      </div>
      {done>0&&<button style={{width:"100%",background:"transparent",border:`1px solid ${C.border}`,borderRadius:"12px",color:C.textDim,cursor:"pointer",fontSize:"0.88rem",padding:"11px",fontFamily:"Georgia,serif",marginTop:"12px"}} onClick={()=>{const ni=items.filter(it=>!it.done);setItems(ni);saveListToFirestore(listCode,ni);}}>🗑 Borrar tachados</button>}
    </div>
  );
}

// ─── PREMIUM ─────────────────────────────────────────────────────────────────
function ModoPremium({isPremium,setIsPremium,profile,C}) {
  const [dietPlan,setDietPlan]=useState(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [paying,setPaying]=useState(false);

  const generateDiet=async()=>{
    setLoading(true);setDietPlan(null);setError(null);
    const ctx=buildProfileContext(profile);
    try{
      const r=await callAI(`Eres nutriólogo experto.${ctx} Plan de comidas 3 días con desayuno, almuerzo y cena.
Responde SOLO JSON sin backticks: {"dias":[{"dia":"Lunes","calorias_total":"X kcal","comidas":[{"tipo":"Desayuno","nombre":"","calorias":"X kcal"},{"tipo":"Almuerzo","nombre":"","calorias":"X kcal"},{"tipo":"Cena","nombre":"","calorias":"X kcal"}]}]}`);
      setDietPlan(r);
    }catch{setError("No se pudo generar el plan.");}
    finally{setLoading(false);}
  };

  const handlePay=async()=>{
    setPaying(true);
    await new Promise(r=>setTimeout(r,1500));
    setIsPremium(true);toast("👑 ¡Bienvenido a Premium!");setPaying(false);
  };

  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};

  if(!isPremium)return(
    <div style={main}>
      <div style={{background:`linear-gradient(135deg,${C.goldDim},#1a1a00)`,border:`1px solid ${C.gold}50`,borderRadius:"16px",padding:"20px",marginBottom:"20px"}}>
        <div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.gold,marginBottom:"4px"}}>👑 Chefify Premium</div>
        <div style={{fontSize:"0.8rem",color:"#c0a840",lineHeight:"1.5"}}>Lleva tu cocina al siguiente nivel</div>
      </div>
      {[["🍳","Recetas ilimitadas",`Plan gratuito limitado a ${DAILY_LIMIT} recetas por día`],
        ["🔥","Calorías por receta","Cuántas calorías tiene cada platillo"],
        ["💪","Macros detallados","Proteínas, carbos y grasas en cada receta"],
        ["📅","Plan de dieta","Plan personalizado según tu objetivo"],
        ["⭐","Recetas Premium","Recetas gourmet y técnicas avanzadas"],
        ["🎯","Recetas por objetivo","Filtradas según tu meta de salud"],
      ].map(([icon,title,desc],i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:"10px",padding:"8px 0",borderBottom:`1px solid ${C.goldDim}`,fontSize:"0.85rem",color:"#e0d090"}}>
          <span style={{fontSize:"1.1rem",flexShrink:0}}>{icon}</span>
          <div><div style={{fontWeight:"bold",color:C.gold,fontSize:"0.88rem"}}>{title}</div><div style={{fontSize:"0.75rem",color:"#a09040",marginTop:"2px"}}>{desc}</div></div>
        </div>
      ))}
      <button style={{width:"100%",background:`linear-gradient(135deg,#c09020,#a07010)`,border:"none",borderRadius:"12px",color:"#fff8e0",cursor:"pointer",fontSize:"1rem",fontWeight:"bold",padding:"15px",fontFamily:"Georgia,serif",marginTop:"20px"}} onClick={handlePay} disabled={paying}>
        {paying?"Procesando...":"💳 Pagar con MercadoPago — $49 MXN/mes"}
      </button>
      <p style={{textAlign:"center",fontSize:"0.72rem",color:C.textDim,marginTop:"10px"}}>Cancela cuando quieras</p>
    </div>
  );

  return(
    <div style={main}>
      <div style={{background:`linear-gradient(135deg,${C.goldDim},#1a1a00)`,border:`1px solid ${C.gold}50`,borderRadius:"16px",padding:"20px",marginBottom:"20px"}}>
        <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          <span style={{fontSize:"1.5rem"}}>👑</span>
          <div><div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.gold}}>Eres Premium ✓</div><div style={{fontSize:"0.75rem",color:"#c0a840"}}>Recetas ilimitadas y todas las funciones activas</div></div>
        </div>
      </div>
      <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px"}}>Plan de dieta personalizado</span>
      <p style={{fontSize:"0.8rem",color:C.textMuted,margin:"4px 0 12px"}}>Objetivo: {profile.goal||"Sin objetivo definido"}</p>
      <button style={{width:"100%",background:`linear-gradient(135deg,#c09020,#a07010)`,border:"none",borderRadius:"12px",color:"#fff8e0",cursor:"pointer",fontSize:"1rem",fontWeight:"bold",padding:"15px",fontFamily:"Georgia,serif"}} onClick={generateDiet} disabled={loading}>{loading?"Generando...":"📅 Generar plan de 3 días"}</button>
      {loading&&<div style={{textAlign:"center",padding:"20px 0",color:C.textMuted}}><div style={{fontSize:"2rem",marginBottom:"10px"}}>🥗</div><p style={{margin:0}}>Creando tu plan...</p></div>}
      {error&&<div style={{background:C.accentDim,borderRadius:"12px",color:C.accent,padding:"14px",textAlign:"center",fontSize:"0.88rem"}}>{error}</div>}
      {dietPlan&&dietPlan.dias?.map((dia,i)=>(
        <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"14px",padding:"16px",marginBottom:"10px",marginTop:"12px"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:"8px"}}>
            <div style={{fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.08em",textTransform:"uppercase"}}>📅 {dia.dia}</div>
            {dia.calorias_total&&<div style={{fontSize:"0.72rem",color:C.gold}}>{dia.calorias_total}</div>}
          </div>
          {dia.comidas?.map((c,j)=>(
            <div key={j} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${C.surface||C.bg}`,fontSize:"0.83rem"}}>
              <span style={{color:C.text}}>{c.tipo}: {c.nombre}</span>
              <span style={{color:C.gold,fontSize:"0.78rem"}}>{c.calorias}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── PERFIL ──────────────────────────────────────────────────────────────────
function ModoProfile({user,profile,setProfile,darkMode,setDarkMode,uid,C}) {
  const [local,setLocal]=useState(profile);
  const [saved,setSaved]=useState(false);
  const [dislikeInput,setDislikeInput]=useState("");

  useEffect(()=>{ setLocal(profile); },[profile]);

  const save=async()=>{
    setProfile(local);
    if(uid) await saveToFirestore(uid,"profile",local);
    setSaved(true);setTimeout(()=>setSaved(false),2500);
    toast("✅ Perfil guardado");
  };

  const addDislike=()=>{
    const v=dislikeInput.trim();
    if(v&&!local.dislikes?.includes(v))setLocal({...local,dislikes:[...(local.dislikes||[]),v]});
    setDislikeInput("");
  };

  const handleSignOut=async()=>{
    await signOut(auth);
    toast("👋 Sesión cerrada");
  };

  const requestNotifications=async()=>{
    if(!("Notification" in window)){toast("⚠️ Tu navegador no soporta notificaciones");return;}
    const perm=await Notification.requestPermission();
    if(perm==="granted"){toast("🔔 Notificaciones activadas");new Notification("🍳 Chefify",{body:"¡Ya recibirás recordatorios para cocinar!"});}
    else toast("⚠️ Permiso denegado");
  };

  const main={maxWidth:"600px",margin:"0 auto",padding:"20px 16px"};
  const inp={width:"100%",background:C.inputBg,border:`1px solid ${C.border}`,borderRadius:"10px",color:C.text,fontSize:"0.95rem",padding:"11px 14px",outline:"none",fontFamily:"Georgia,serif",boxSizing:"border-box"};
  const toggle={display:"flex",justifyContent:"space-between",alignItems:"center",background:C.card,border:`1px solid ${C.border}`,borderRadius:"12px",padding:"14px 16px",marginTop:"12px",cursor:"pointer"};

  return(
    <div style={main}>
      <div style={{background:`linear-gradient(135deg,${C.greenFaint},${C.card})`,border:`1px solid ${C.border}`,borderRadius:"16px",padding:"20px",marginBottom:"20px",textAlign:"center"}}>
        {user?.photoURL&&<img src={user.photoURL} alt="foto" style={{width:"60px",height:"60px",borderRadius:"50%",marginBottom:"8px",border:`2px solid ${C.borderLight}`}}/>}
        <div style={{fontSize:"1.1rem",fontWeight:"bold",color:C.green}}>{user?.displayName||local.name||"Mi perfil"}</div>
        <div style={{fontSize:"0.78rem",color:C.textMuted,marginTop:"4px"}}>{user?.email}</div>
      </div>
      <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px"}}>Tu nombre en la app</span>
      <input style={inp} placeholder="¿Cómo te llamamos?" value={local.name||""} onChange={e=>setLocal({...local,name:e.target.value})}/>
      <MultiChips label="Restricciones alimenticias" options={RESTRICTIONS} selected={local.restrictions||[]} onChange={v=>setLocal({...local,restrictions:v})} C={C}/>
      <MultiChips label="Alergias" options={ALLERGIES} selected={local.allergies||[]} onChange={v=>setLocal({...local,allergies:v})} C={C}/>
      <span style={{display:"block",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:"8px",marginTop:"18px"}}>Ingredientes que no te gustan</span>
      <div style={{display:"flex",gap:"8px"}}>
        <input style={{flex:1,background:C.inputBg,border:`1px solid ${C.border}`,borderRadius:"10px",color:C.text,fontSize:"0.95rem",padding:"11px 14px",outline:"none",fontFamily:"Georgia,serif"}} placeholder="Ej: cilantro, hígado..." value={dislikeInput} onChange={e=>setDislikeInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addDislike()}/>
        <button style={{background:C.borderLight,border:"none",borderRadius:"10px",color:C.green,cursor:"pointer",fontSize:"1.4rem",padding:"0 13px"}} onClick={addDislike}>+</button>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:"7px",marginTop:"10px"}}>
        {(local.dislikes||[]).map((d,i)=>(
          <span key={i} style={{background:C.greenFaint,border:`1px solid ${C.borderLight}`,borderRadius:"20px",color:C.textMuted,fontSize:"0.8rem",padding:"4px 12px",display:"flex",alignItems:"center",gap:"7px"}}>
            {d}<button style={{background:"none",border:"none",color:C.textDim,cursor:"pointer",fontSize:"0.85rem",padding:"0"}} onClick={()=>setLocal({...local,dislikes:local.dislikes.filter((_,idx)=>idx!==i)})}>✕</button>
          </span>
        ))}
      </div>
      <FilterChips label="Mi objetivo" options={GOALS} value={local.goal||"Sin objetivo"} onChange={v=>setLocal({...local,goal:v})} C={C}/>
      <div style={{marginTop:"24px",marginBottom:"8px",fontSize:"0.72rem",fontWeight:"bold",color:C.green,letterSpacing:"0.1em",textTransform:"uppercase"}}>Ajustes</div>
      <div style={toggle} onClick={()=>setDarkMode(!darkMode)}>
        <div><div style={{fontSize:"0.88rem",fontWeight:"bold",color:C.text}}>{darkMode?"🌙 Modo oscuro":"☀️ Modo claro"}</div><div style={{fontSize:"0.72rem",color:C.textMuted,marginTop:"2px"}}>Cambiar tema de la app</div></div>
        <div style={{width:"40px",height:"22px",borderRadius:"11px",background:darkMode?C.green:C.border,position:"relative",transition:"background 0.2s"}}>
          <div style={{position:"absolute",top:"3px",left:darkMode?"21px":"3px",width:"16px",height:"16px",borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
        </div>
      </div>
      <div style={toggle} onClick={requestNotifications}>
        <div><div style={{fontSize:"0.88rem",fontWeight:"bold",color:C.text}}>🔔 Notificaciones</div><div style={{fontSize:"0.72rem",color:C.textMuted,marginTop:"2px"}}>Recordatorios diarios para cocinar</div></div>
        <span style={{fontSize:"0.8rem",color:C.green}}>Activar →</span>
      </div>
      <button style={{background:`linear-gradient(135deg,#3a7a3a,#2d5a2d)`,border:"none",borderRadius:"10px",color:"#e0ede0",cursor:"pointer",fontSize:"0.88rem",fontWeight:"bold",padding:"13px",fontFamily:"Georgia,serif",marginTop:"20px",width:"100%"}} onClick={save}>💾 Guardar perfil</button>
      {saved&&<div style={{textAlign:"center",color:C.green,fontSize:"0.82rem",marginTop:"10px"}}>✅ ¡Perfil guardado!</div>}
      <button style={{background:"transparent",border:`1px solid ${C.accent}30`,borderRadius:"10px",color:C.accent,cursor:"pointer",fontSize:"0.85rem",padding:"12px",fontFamily:"Georgia,serif",marginTop:"12px",width:"100%"}} onClick={handleSignOut}>Cerrar sesión</button>
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
const DEFAULT_PROFILE={name:"",restrictions:[],allergies:[],dislikes:[],goal:"Sin objetivo"};

export default function App() {
  const [user,setUser]=useState(undefined); // undefined = cargando, null = no autenticado
  const [tab,setTab]=useState(0);
  const [overlay,setOverlay]=useState(null);
  const [profile,setProfile]=useState(DEFAULT_PROFILE);
  const [isPremium,setIsPremium]=useState(false);
  const [pendingListItems,setPendingListItems]=useState([]);
  const [darkMode,setDarkMode]=useState(true);
  const C=darkMode?DARK:LIGHT;
  const uid=user?.uid||null;
  const recipeUtils=useRecipeUtils(uid);

  useEffect(()=>{
    const unsub=onAuthStateChanged(auth,async(u)=>{
      setUser(u);
      if(u){
        const p=await loadFromFirestore(u.uid,"profile");
        if(p) setProfile(p);
        else if(u.displayName) setProfile(prev=>({...prev,name:u.displayName}));
      }
    });
    return unsub;
  },[]);

  // Pantalla de carga
  if(user===undefined)return(
    <div style={{minHeight:"100vh",background:DARK.bg,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:"16px"}}>
      <div style={{fontSize:"3rem"}}>🍳</div>
      <div style={{color:DARK.green,fontSize:"1.2rem",fontWeight:"bold"}}>Chefify</div>
    </div>
  );

  // Pantalla de login
  if(!user)return<LoginScreen C={C}/>;

  const handleAddToList=(ingredients)=>{
    setPendingListItems(ingredients||[]);setOverlay("lista");
    toast("📝 Abriendo tu lista del súper...");
  };
  const openOverlay=(name)=>setOverlay(overlay===name?null:name);

  const bottomTabs=[
    {label:"No sé qué cocinar",icon:"🤷"},
    {label:"Buscar receta",icon:"🔍"},
    {label:"Trending",icon:"🔥"},
    {label:"Favoritos",icon:"⭐"},
    {label:"Historial",icon:"📊"},
  ];

  const iconBtn={background:"transparent",border:`1px solid ${C.border}`,borderRadius:"10px",cursor:"pointer",fontSize:"1.1rem",padding:"6px 9px",color:C.textMuted,lineHeight:1,position:"relative"};
  const iconBtnA={...iconBtn,background:C.greenFaint,border:`1px solid ${C.green}`,color:C.green};
  const iconBtnG={...iconBtn,background:C.goldDim,border:`1px solid ${C.gold}60`,color:C.gold};
  const bTab={flex:1,padding:"12px 4px 10px",border:"none",background:"transparent",color:C.textDim,cursor:"pointer",fontSize:"0.6rem",fontFamily:"Georgia,serif",display:"flex",flexDirection:"column",alignItems:"center",gap:"3px"};
  const bTabA={...bTab,color:C.green};

  return(
    <div style={{minHeight:"100vh",background:C.bg,fontFamily:"Georgia,serif",color:C.text,paddingBottom:"80px"}}>
      <ToastProvider C={C}/>
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"16px 16px 0",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",marginBottom:"12px"}}>
          <span style={{fontSize:"1.6rem",marginRight:"8px"}}>🍳</span>
          <div>
            <p style={{fontSize:"1.3rem",fontWeight:"bold",color:C.green,margin:0}}>Chefify</p>
            <p style={{fontSize:"0.68rem",color:C.textMuted,margin:0}}>Recetas para todos los mexicanos 🇲🇽</p>
          </div>
          <div style={{display:"flex",gap:"6px",marginLeft:"auto",alignItems:"center"}}>
            {user?.photoURL&&<img src={user.photoURL} alt="" style={{width:"28px",height:"28px",borderRadius:"50%",border:`1px solid ${C.borderLight}`}}/>}
            <button style={overlay==="lista"?iconBtnA:iconBtn} onClick={()=>openOverlay("lista")} title="Lista del súper">📝</button>
            <button style={isPremium?iconBtnG:(overlay==="premium"?iconBtnA:iconBtn)} onClick={()=>openOverlay("premium")} title="Premium">👑</button>
            <button style={overlay==="perfil"?iconBtnA:iconBtn} onClick={()=>openOverlay("perfil")} title="Perfil y ajustes">⚙️</button>
          </div>
        </div>
      </div>

      {overlay==="lista"&&<ModoLista uid={uid} profile={profile} pendingItems={pendingListItems} onClearPending={()=>setPendingListItems([])} C={C}/>}
      {overlay==="premium"&&<ModoPremium isPremium={isPremium} setIsPremium={setIsPremium} profile={profile} C={C}/>}
      {overlay==="perfil"&&<ModoProfile user={user} profile={profile} setProfile={setProfile} darkMode={darkMode} setDarkMode={setDarkMode} uid={uid} C={C}/>}

      {!overlay&&(
        <>
          {tab===0&&<ModoRefri profile={profile} isPremium={isPremium} recipeUtils={recipeUtils} onAddToList={handleAddToList} C={C}/>}
          {tab===1&&<ModoBuscar profile={profile} isPremium={isPremium} recipeUtils={recipeUtils} onAddToList={handleAddToList} C={C}/>}
          {tab===2&&<ModoTrending profile={profile} isPremium={isPremium} recipeUtils={recipeUtils} onAddToList={handleAddToList} C={C}/>}
          {tab===3&&<ModoFavoritos favorites={recipeUtils.favorites} isPremium={isPremium} recipeUtils={recipeUtils} onAddToList={handleAddToList} C={C}/>}
          {tab===4&&<ModoHistorial history={recipeUtils.history} isPremium={isPremium} recipeUtils={recipeUtils} onAddToList={handleAddToList} C={C}/>}
        </>
      )}

      <div style={{position:"fixed",bottom:0,left:0,right:0,background:C.surface,borderTop:`1px solid ${C.border}`,display:"flex",zIndex:100}}>
        {bottomTabs.map((t,i)=>(
          <button key={i} style={!overlay&&tab===i?bTabA:bTab} onClick={()=>{setOverlay(null);setTab(i);}}>
            <span style={{fontSize:"1.3rem"}}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
