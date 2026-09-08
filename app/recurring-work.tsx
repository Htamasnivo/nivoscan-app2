import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

export type RecurringKind = "plan" | "backlog" | "priority" | "manual";
export type RecurringInstance = {
  id: string; station_key: string; megnevezes: string; name_key: string;
  source_kind: RecurringKind; source_id: string; planned_quantity: number | null;
  completed_quantity: number; status: "waiting" | "in-progress" | "done";
  active_segment_id: string | null; started_at: string | null; last_started_at: string | null;
  ended_at: string | null; start_worker_name: string | null; end_worker_name: string | null;
  is_reproduction: boolean; reproduction_number: number | null;
};
export type RecurringCandidate = {
  kind: RecurringKind; source_id: string; order_number: string; megnevezes: string;
  planned_quantity: number | string | null; plan_date: string | null; data?: Record<string, unknown>;
};
export type RecurringRead = {
  is_recurring: boolean; catalog: Array<{id: number; megnevezes: string}>;
  settings: {station_key: string; columns_count: number; rows_count: number};
  candidates: RecurringCandidate[]; instances: RecurringInstance[];
};
export type RecurringSession = {worker_id: number; token: string; expires_at: string};
export function recurringNameKey(value: string): string {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g," ").toLowerCase();
}
export function recurringSourceKey(kind: RecurringKind, sourceId: string): string {
  return `${kind === "backlog" ? "plan" : kind}:${sourceId}`;
}
export function recurringInstanceFor(instances: RecurringInstance[], kind: RecurringKind, sourceId: string): RecurringInstance | undefined {
  return instances.find(i => recurringSourceKey(i.source_kind,i.source_id) === recurringSourceKey(kind,sourceId));
}
export function recurringRemaining(i: RecurringInstance): number | null {
  return i.planned_quantity === null ? null : Math.max(0,i.planned_quantity-i.completed_quantity);
}
export function recurringStatusLabel(i: RecurringInstance): string {
  if(i.status === "done") return "Kész";
  if(i.status === "in-progress") return i.planned_quantity === null ? "Folyamatban" : `Folyamatban – még ${recurringRemaining(i)} db`;
  return "Várakozik";
}
export async function recurringRead(db: SupabaseClient, station: string, name?: string): Promise<RecurringRead> {
  const {data,error}=await db.rpc("nivo_recurring_read",{p_station:station,p_name:name ?? null});
  if(error) throw error;
  return data as RecurringRead;
}
export async function recurringAuthenticate(db: SupabaseClient, workerId: number, password: string): Promise<RecurringSession> {
  const {data,error}=await db.rpc("nivo_recurring_authenticate",{p_worker_id:workerId,p_password:password});
  if(error) throw error;
  if(data?.error) throw new Error(String(data.error));
  if(!data?.token) throw new Error("Nem sikerült a dolgozói azonosítás.");
  return data as RecurringSession;
}
export async function recurringMutate(db: SupabaseClient, token: string, operation: string, payload: Record<string,unknown>, requestId = crypto.randomUUID()): Promise<any> {
  const {data,error}=await db.rpc("nivo_recurring_mutate",{p_token:token,p_operation:operation,p_payload:payload,p_request_id:requestId});
  if(error) throw error;
  if(data?.error) throw new Error(String(data.error));
  return data;
}

const QR_WIDTH_MM=37.5;
const QR_HEIGHT_MM=43;
const QR_IMAGE_MM=33.5;
export function validateRecurringQrLayout(columns:number,rows:number): void {
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||columns>20||rows>20) throw new Error("A sorok és oszlopok száma 1 és 20 közötti egész legyen.");
  if(columns*QR_WIDTH_MM>200 || rows*QR_HEIGHT_MM>275) throw new Error("Ennyi címke fix méretben nem fér el az A4-es lapon. Csökkentsd a sorok vagy oszlopok számát.");
}
export async function buildRecurringQrPdf(
  sheets:Array<{station:string;names:string[];columns:number;rows:number}>,
  pdfFactory:()=>any, registerFonts:(doc:any)=>void
):Promise<Blob> {
  if(!sheets.length) throw new Error("Nincs kiválasztott munkaállomás.");
  const doc=pdfFactory();
  registerFonts(doc);
  let pageCount=0;
  const cache=new Map<string,string>();
  for(const sheet of sheets){
    const {station,columns,rows}=sheet;
    validateRecurringQrLayout(columns,rows);
    const names=Array.from(new Map(sheet.names.map(n=>[recurringNameKey(n),n])).values()).filter(Boolean);
    if(!names.length) continue;
    const perPage=columns*rows;
    for(let offset=0;offset<names.length;offset+=perPage){
      if(pageCount++) doc.addPage("a4","portrait");
      doc.setFillColor(255,255,255); doc.rect(0,0,210,297,"F");
      doc.setTextColor(0,0,0);doc.setFont("DejaVuSans","bold");doc.setFontSize(11);
      doc.text(station,105,9,{align:"center"});
      const slotW=200/columns,slotH=275/rows;
      const pageNames=names.slice(offset,offset+perPage);
      for(let index=0;index<pageNames.length;index++){
        const name=pageNames[index];
        const col=index%columns,row=Math.floor(index/columns);
        const x=5+col*slotW+(slotW-QR_WIDTH_MM)/2;
        const y=14+row*slotH+(slotH-QR_HEIGHT_MM)/2;
        let image=cache.get(name);
        if(!image){image=await QRCode.toDataURL(name,{errorCorrectionLevel:"M",margin:2,width:512,color:{dark:"#000000",light:"#FFFFFF"}});cache.set(name,image);}
        doc.setFillColor(0,0,0);doc.roundedRect(x,y,QR_WIDTH_MM,QR_HEIGHT_MM,1.5,1.5,"F");
        doc.setFillColor(255,255,255);doc.roundedRect(x+1,y+1,QR_WIDTH_MM-2,QR_IMAGE_MM+2,0.8,0.8,"F");
        doc.addImage(image,"PNG",x+2,y+2,QR_IMAGE_MM,QR_IMAGE_MM);
        doc.setTextColor(255,255,255);doc.setFont("DejaVuSans","normal");
        let size=8.5,lines:string[]=[];
        for(;size>=4.5;size-=0.5){doc.setFontSize(size);lines=doc.splitTextToSize(name,QR_WIDTH_MM-2);if(lines.length<=2 && lines.length*(size*0.3528*1.1)<=5.5)break;}
        if(size<4.5){
          size=4.5;doc.setFontSize(size);
          const maxWidth=QR_WIDTH_MM-2;
          let label=name;
          while(label.length>1&&doc.splitTextToSize(label+"…",maxWidth).length>2)label=label.slice(0,-1);
          lines=doc.splitTextToSize(label===name?label:label+"…",maxWidth);
        }
        doc.text(lines,x+QR_WIDTH_MM/2,y+QR_HEIGHT_MM-5.2+(5.2-lines.length*size*0.3528*1.1)/2,{align:"center",baseline:"top"});
      }
    }
  }
  if(!pageCount) throw new Error("A kiválasztott munkaállomásokon nincs feltöltött megnevezés.");
  return doc.output("blob");
}

export function RecurringWorksAdmin(props:{
 db:SupabaseClient;stations:string[];requireToken:()=>Promise<string>;
 waitForXlsx:()=>Promise<any>;pdfFactory:()=>Promise<any>;registerFonts:(doc:any)=>void;
 onMessage:(message:string,error?:boolean)=>void;
}):React.JSX.Element {
 const {db,stations,requireToken,onMessage}=props;
 const [selected,setSelected]=useState<string[]>([]);
 const [file,setFile]=useState<File|null>(null);
 const [busy,setBusy]=useState(false);
 const [layoutStation,setLayoutStation]=useState(stations[0]||"");
 const [cache,setCache]=useState<Record<string,RecurringRead>>({});
 const [columns,setColumns]=useState(4),[rows,setRows]=useState(6);
 const [lastExport,setLastExport]=useState(""),[lastImport,setLastImport]=useState("");
 const activeStations=useMemo(()=>selected.length ? stations.filter(s=>selected.includes(s)) : stations,[stations,selected]);
 const load=async(station:string):Promise<RecurringRead>=>{const data=await recurringRead(db,station);setCache(prev=>({...prev,[station]:data}));return data;};
 useEffect(()=>{if(!layoutStation && stations[0])setLayoutStation(stations[0]);},[layoutStation,stations]);
 useEffect(()=>{if(!layoutStation)return;let cancelled=false;void recurringRead(db,layoutStation).then(data=>{if(cancelled)return;setCache(prev=>({...prev,[layoutStation]:data}));setColumns(data.settings?.columns_count??4);setRows(data.settings?.rows_count??6);}).catch(e=>onMessage(String(e.message||e),true));return()=>{cancelled=true;};},[db,layoutStation]);
 const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await work();}catch(e){onMessage(e instanceof Error?e.message:String(e),true);}finally{setBusy(false);}};
 const exportExcel=(withData:boolean)=>run(async()=>{
  const xlsx=await props.waitForXlsx();const book=xlsx.utils.book_new();
  for(const station of activeStations){const data=withData?await load(station):null;
   const values=[ ["Megnevezés"],...(withData?(data?.catalog||[]).map(r=>[r.megnevezes]):[[""]]) ];
   const sheet=xlsx.utils.aoa_to_sheet(values);sheet["!cols"]=[{wch:65}];sheet["!freeze"]={xSplit:0,ySplit:1};sheet["!autofilter"]={ref:`A1:A${Math.max(1,values.length)}`};
   xlsx.utils.book_append_sheet(book,sheet,station.slice(0,31));
  }
  const bytes=xlsx.write(book,{bookType:"xlsx",type:"array"});
  const blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`Gyartasi_munkak_${withData?"adatokkal":"minta"}.xlsx`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  setLastExport(new Date().toLocaleString("hu-HU"));onMessage("A Gyártási munkák Excel elkészült.");
 });
 const importExcel=()=>run(async()=>{
  if(!file)throw new Error("Válassz ki egy XLSX-fájlt.");
  const xlsx=await props.waitForXlsx();const book=xlsx.read(await file.arrayBuffer(),{type:"array"});
  const sheets:Array<{station:string;names:string[]}>=[];const seen=new Set<string>();
  for(const sheetName of book.SheetNames){const station=stations.find(s=>recurringNameKey(s)===recurringNameKey(sheetName));
   if(!station)throw new Error(`Ismeretlen munkaállomás-munkafül: ${sheetName}`);
   if(seen.has(station))throw new Error(`Duplikált munkaállomás-munkafül: ${sheetName}`);seen.add(station);
   const matrix=xlsx.utils.sheet_to_json(book.Sheets[sheetName],{header:1,raw:false,defval:""}) as unknown[][];
   if(recurringNameKey(String(matrix[0]?.[0]??""))!=="megnevezes")throw new Error(`A(z) ${sheetName} munkafül első oszlopa Megnevezés legyen.`);
   const names=matrix.slice(1).map(r=>String(r[0]??"").trim()).filter(Boolean);
   sheets.push({station,names});
  }
  if(!sheets.length)throw new Error("A munkafüzet üres.");
  const token=await requireToken();
  await recurringMutate(db,token,"import_workbook",{sheets});
  await Promise.all(sheets.map(s=>load(s.station)));
  setLastImport(new Date().toLocaleString("hu-HU"));onMessage("A megnevezések feltöltve. A korábbi munkák megmaradtak, az ismétlődő nevek nem duplikálódtak.");
 });
 const saveLayout=()=>run(async()=>{
  validateRecurringQrLayout(columns,rows);
  const token=await requireToken();await recurringMutate(db,token,"settings",{station:layoutStation,columns,rows});await load(layoutStation);onMessage("A QR-elrendezés mentve.");
 });
 const makePdf=()=>{
  if(busy)return;
  const tab=window.open("about:blank","_blank");
  if(tab)tab.opener=null;
  return run(async()=>{
   try{
    const sheets=[] as Array<{station:string;names:string[];columns:number;rows:number}>;
    for(const station of activeStations){const data=await load(station);sheets.push({station,names:data.catalog.map(r=>r.megnevezes),columns:data.settings?.columns_count??4,rows:data.settings?.rows_count??6});}
    const jspdf=await props.pdfFactory();const blob=await buildRecurringQrPdf(sheets,()=>new jspdf.jsPDF({unit:"mm",format:"a4",orientation:"portrait"}),props.registerFonts);
    const url=URL.createObjectURL(blob);
    if(tab&&!tab.closed)tab.location.href=url;
    else{const a=document.createElement("a");a.href=url;a.download="Gyartasi_munkak_QR.pdf";a.click();}
    setTimeout(()=>URL.revokeObjectURL(url),60000);onMessage("A nyomtatható A4-es QR-PDF elkészült.");
   }catch(e){if(tab&&!tab.closed)tab.close();throw e;}
  });
 };
 const btn:React.CSSProperties={background:"#314b50",color:"#fff",border:"1px solid #526b70",borderRadius:9,padding:"10px 14px",cursor:"pointer",fontWeight:800};
 return <section data-office-window="production-plan:recurring-works" style={{background:"#203438",border:"1px solid #526b70",borderRadius:14,padding:16,display:"grid",gap:12,color:"#f8fafc"}}>
  <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{background:"#365960",padding:"7px 12px",borderRadius:9,fontWeight:900}}>3</span><div><h3 style={{margin:0}}>Gyártási munkák</h3><small>Visszatérő munkák törzsadatai, Excel import/export és QR-kódok.</small></div></div>
  <div style={{background:"#2b4448",padding:12,borderRadius:10}}><strong>Exportálandó munkaállomások</strong><div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:9}}>
   {stations.map(station=><label key={station} style={{display:"flex",gap:7,alignItems:"center",border:"1px solid #526b70",borderRadius:8,padding:"9px 10px",minWidth:130,cursor:"pointer"}}><input type="checkbox" checked={selected.includes(station)} onChange={e=>setSelected(prev=>e.target.checked?[...prev,station]:prev.filter(s=>s!==station))}/>{station}</label>)}
  </div><div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}><button style={btn} disabled={busy} onClick={()=>setSelected([...stations])}>Összes kijelölése</button><button style={btn} disabled={busy} onClick={()=>setSelected([])}>Kijelölés törlése</button></div><small>Kijelölés nélkül minden munkaállomás szerepel az exportban és a QR-PDF-ben.</small></div>
  <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"end",background:"#2b4448",padding:12,borderRadius:10}}><label style={{flex:"1 1 300px"}}>Feltöltendő XLSX fájl<input type="file" accept=".xlsx" onChange={e=>setFile(e.target.files?.[0]||null)} style={{display:"block",width:"100%",marginTop:7}}/></label><button style={btn} disabled={busy} onClick={()=>void exportExcel(false)}>Minta Excel letöltése</button><button style={btn} disabled={busy} onClick={()=>void exportExcel(true)}>Minta Excel letöltése adatokkal</button><button style={btn} disabled={busy||!file} onClick={()=>void importExcel()}>Gyártási munkák feltöltése</button></div>
  <div style={{display:"flex",gap:12,flexWrap:"wrap",fontSize:12,color:"#cbd5e1"}}><span>Utolsó export: {lastExport||"Még nem történt"}</span><span>Utolsó feltöltés: {lastImport||"Még nem történt"}</span></div>
  <div style={{background:"#2b4448",padding:12,borderRadius:10,display:"grid",gap:10}}><strong>QR-kódos A4 – oszlop-/sorszerkesztő</strong><div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"end"}}><label>Munkaállomás<select value={layoutStation} onChange={e=>setLayoutStation(e.target.value)} style={{display:"block",padding:9,background:"#172c30",color:"white"}}>{stations.map(s=><option key={s} value={s}>{s}</option>)}</select></label><label>Oszlopok száma<input type="number" min={1} max={20} value={columns} onChange={e=>setColumns(Number(e.target.value))} style={{display:"block",width:85,padding:9}}/></label><label>Sorok száma<input type="number" min={1} max={20} value={rows} onChange={e=>setRows(Number(e.target.value))} style={{display:"block",width:85,padding:9}}/></label><button style={btn} disabled={busy} onClick={()=>void saveLayout()}>Elrendezés mentése</button><button style={btn} disabled={busy} onClick={()=>void makePdf()}>QR-kód generálása</button></div><small>Alapértelmezés: 4 × 6. A QR mérete fix; csak a címkék közötti távolság változik. A beállítás közös, munkaállomásonként mentődik. Egy megnevezésből egy QR készül, a pontos névvel.</small></div>
 </section>;
}


// A visszatérő sorok megjelenítéséhez kizárólag a konkrét forrásazonosító számít.
// A korábbi, csak név alapján naplózott START/END nem teljesíthet másik sort.
export function recurringCardSnapshot(read: RecurringRead) {
 const names=new Set((read.catalog||[]).map(r=>recurringNameKey(r.megnevezes)));
 const instances=new Map<string,RecurringInstance>();
 for(const i of read.instances||[]) instances.set(recurringSourceKey(i.source_kind,i.source_id),i);
 return {names,instances};
}
export type RecurringCardSnapshot=ReturnType<typeof recurringCardSnapshot>;
export function recurringCardValues(snapshot:RecurringCardSnapshot,kind:RecurringKind,sourceId:string,name:string) {
 if(!snapshot.names.has(recurringNameKey(name)))return null;
 const instance=snapshot.instances.get(recurringSourceKey(kind,sourceId));
 const status=instance?.status||"waiting";
 return {
  instance,
  status,
  statusLabel:instance?recurringStatusLabel(instance):"Várakozik",
  startWorkerName:instance?.start_worker_name||"",
  endWorkerName:instance?.end_worker_name||"",
  lastWorkerName:instance?.end_worker_name||"",
  startedAt:instance?.last_started_at||instance?.started_at||null,
  endedAt:instance?.ended_at||null,
  completedQuantity:instance?.completed_quantity||0,
  remainingQuantity:instance?recurringRemaining(instance):null,
  isReproduction:instance?.is_reproduction||false,
  reproductionNumber:instance?.reproduction_number||null,
 };
}

export type RecurringSelection={station:string;name:string;read:RecurringRead;requestedAction:"START"|"END"|"choose";initialQuantity?:string};
type RecurringChoice={kind:RecurringKind;source_id:string;name:string;planned:number|null;date:string|null;orderNumber:string;instance?:RecurringInstance;manual?:boolean};
export function recurringChoices(read:RecurringRead):RecurringChoice[] {
 const bySource=new Map<string,RecurringChoice>();
 for(const c of read.candidates||[]){
  const key=recurringSourceKey(c.kind,c.source_id);
  const instance=recurringInstanceFor(read.instances||[],c.kind,c.source_id);
  bySource.set(key,{kind:c.kind,source_id:c.source_id,name:c.megnevezes,planned:c.planned_quantity===null?null:Number(c.planned_quantity),date:c.plan_date,orderNumber:c.order_number,instance});
 }
 // An active occurrence must remain selectable even if its source was later removed.
 for(const i of read.instances||[]){
  const key=recurringSourceKey(i.source_kind,i.source_id);
  if(!bySource.has(key)&&i.status!=="done")bySource.set(key,{kind:i.source_kind,source_id:i.source_id,name:i.megnevezes,planned:i.planned_quantity,date:null,orderNumber:i.megnevezes,instance:i});
 }
 return [...bySource.values()];
}
const recurringDialogButton:React.CSSProperties={background:"#314b50",border:"1px solid #64748b",borderRadius:9,padding:"10px 14px",color:"#fff",fontWeight:800,cursor:"pointer"};
const recurringDialogInput:React.CSSProperties={padding:10,border:"1px solid #64748b",borderRadius:8,background:"#101f29",color:"#fff",width:"100%"};
const recurringDialogPanel:React.CSSProperties={width:"100%",maxWidth:760,maxHeight:"90vh",overflowY:"auto",background:"#203438",color:"#f8fafc",border:"1px solid #526b70",borderRadius:15,padding:18,boxShadow:"0 20px 50px rgba(0,0,0,.45)"};
const recurringDialogBackdrop:React.CSSProperties={position:"fixed",inset:0,zIndex:10020,background:"rgba(2,6,23,.86)",display:"grid",placeItems:"center",padding:12};

// The password is used only for a server-validated, short-lived session. It is
// never stored in localStorage or included in a work log.
export function useRecurringAccess(db:SupabaseClient|null,workerId:number|null) {
 const [session,setSession]=useState<RecurringSession|null>(null);
 const [gate,setGate]=useState(false),[password,setPassword]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const pending=useRef<{resolve:(token:string)=>void;reject:(error:Error)=>void}|null>(null);
 const sessionRef=useRef<RecurringSession|null>(null);
 const clear=useCallback(()=>{sessionRef.current=null;setSession(null);setPassword("");if(pending.current){pending.current.reject(new Error("Azonosítás megszakítva."));pending.current=null;}setGate(false);},[]);
 useEffect(()=>{clear();},[workerId,clear]);
 const requireToken=useCallback(async():Promise<string>=>{
  if(!db||workerId===null)throw new Error("Előbb azonosítsd magad dolgozóként.");
  const s=sessionRef.current;
  if(s&&s.worker_id===workerId&&new Date(s.expires_at).getTime()>Date.now()+30000)return s.token;
  if(pending.current)throw new Error("Egy azonosítás már folyamatban van.");
  setError("");setPassword("");setGate(true);
  return new Promise<string>((resolve,reject)=>{pending.current={resolve,reject};});
 },[db,workerId]);
 const cancel=()=>{if(pending.current){pending.current.reject(new Error("Azonosítás megszakítva."));pending.current=null;}setGate(false);setPassword("");setError("");};
 const submit=async()=>{
  if(!db||workerId===null||busy)return;
  setBusy(true);setError("");
  try{const next=await recurringAuthenticate(db,workerId,password);sessionRef.current=next;setSession(next);setGate(false);setPassword("");pending.current?.resolve(next.token);pending.current=null;}
  catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 };
 const dialog=gate?<div style={recurringDialogBackdrop}><div role="dialog" aria-modal="true" aria-label="Gyártási munkák azonosítás" style={{...recurringDialogPanel,maxWidth:420}}>
  <h3 style={{marginTop:0}}>Gyártási munkák – azonosítás</h3>
  <p style={{color:"#cbd5e1"}}>A módosítás előtt add meg a saját dolgozói jelszavad. A jogosultságot a Supabase ellenőrzi.</p>
  <form onSubmit={e=>{e.preventDefault();void submit();}}><label>Jelszó<input autoFocus type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} style={{...recurringDialogInput,marginTop:6}}/></label>
  {error&&<p role="alert" style={{color:"#fca5a5"}}>{error}</p>}
  <div style={{display:"flex",gap:9,marginTop:16}}><button type="submit" style={recurringDialogButton} disabled={busy||!password}>{busy?"Ellenőrzés...":"Azonosítás"}</button><button type="button" style={recurringDialogButton} onClick={cancel}>Mégse</button></div></form>
 </div></div>:null;
 return {session,requireToken,clear,dialog};
}

export function RecurringWorkDialog(props:{
 db:SupabaseClient;selection:RecurringSelection;requireToken:()=>Promise<string>;
 onClose:()=>void;onSaved:(result:any,action:"START"|"END")=>void;
}):React.JSX.Element {
 const {db,selection,requireToken,onClose,onSaved}=props;
 const choices=useMemo(()=>recurringChoices(selection.read),[selection.read]);
 const available=useMemo(()=>selection.requestedAction==="END"?choices.filter(c=>Boolean(c.instance?.active_segment_id)):choices.filter(c=>c.instance?.status!=="done"),[choices,selection.requestedAction]);
 const [selectedKey,setSelectedKey]=useState(()=>available.length===1?recurringSourceKey(available[0].kind,available[0].source_id):"");
 const [manual,setManual]=useState(available.length===0&&selection.requestedAction!=="END"),[reproduction,setReproduction]=useState(false),[quantity,setQuantity]=useState(selection.initialQuantity||""),[note,setNote]=useState("");
 const manualId=useRef(crypto.randomUUID());
 const request=useRef<{fingerprint:string;id:string}|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const selected=available.find(c=>recurringSourceKey(c.kind,c.source_id)===selectedKey);
 const action:"START"|"END"=selection.requestedAction==="END"||(!manual&&Boolean(selected?.instance?.active_segment_id))?"END":"START";
 const source=manual?undefined:selected;
 const planned=source?.instance?.planned_quantity??source?.planned??null;
 const completed=source?.instance?.completed_quantity??0;
 const remaining=planned===null?null:Math.max(0,planned-completed);
 const run=async()=>{
  if(busy)return;
  if(!manual&&!source){setError("Válaszd ki a konkrét kártyasort.");return;}
  if(action==="END"&&(!/^\d+$/.test(quantity)||Number(quantity)<=0||!Number.isSafeInteger(Number(quantity))||Number(quantity)>2147483647)){setError("Az elkészült darabszám kötelező, pozitív egész szám.");return;}
  setBusy(true);setError("");
  try{
   const token=await requireToken();
   const payload:Record<string,unknown>={station:selection.station,megnevezes:selection.name};
   if(action==="START"){
    Object.assign(payload,{kind:manual?"manual":source!.kind,source_id:manual?manualId.current:source!.source_id,instance_id:manual?null:source?.instance?.id??null,reproduction:manual&&reproduction});
    if(manual&&reproduction&&planned!==null)payload.planned_quantity=planned;
   }else Object.assign(payload,{instance_id:source!.instance!.id,quantity:Number(quantity),note});
   const fingerprint=JSON.stringify({action,payload});
   if(request.current?.fingerprint!==fingerprint)request.current={fingerprint,id:crypto.randomUUID()};
   const result=await recurringMutate(db,token,action.toLowerCase(),payload,request.current.id);
   onSaved(result,action);
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 return <div style={recurringDialogBackdrop}><div role="dialog" aria-modal="true" aria-label="Visszatérő munka" style={recurringDialogPanel}>
  <h3 style={{marginTop:0}}>Visszatérő munka</h3>
  <p style={{margin:"4px 0 14px",color:"#cbd5e1"}}><strong>{selection.name}</strong> · {selection.station}</p>
  <div style={{display:"grid",gap:7,maxHeight:360,overflowY:"auto"}}>
   {available.map(c=>{const key=recurringSourceKey(c.kind,c.source_id);const selectedNow=selectedKey===key&&!manual;const status=c.instance?.status||"waiting";return <button key={key} type="button" onClick={()=>{setSelectedKey(key);setManual(false);setQuantity(selection.initialQuantity||"");setError("");}} style={{...recurringDialogButton,textAlign:"left",background:selectedNow?"#12678b":"#263d43",borderColor:selectedNow?"#67e8f9":"#526b70"}}>
    <strong>{c.kind==="priority"?"Prioritási":c.kind==="backlog"?"Lemaradások":c.kind==="manual"?"Terv nélküli":"Termelési kártya"}</strong> · {c.name}<br/>
    <span style={{fontSize:12,color:"#cbd5e1"}}>Dátum: {c.date||"–"} · Terv: {c.planned??"–"} db · {c.instance?recurringStatusLabel(c.instance):"Várakozik"}{c.instance?.active_segment_id?" · Nyitott START":""}</span>
   </button>;})}
   {selection.requestedAction!=="END"&&<button type="button" onClick={()=>{setManual(true);setSelectedKey("");setQuantity(selection.initialQuantity||"");setError("");}} style={{...recurringDialogButton,textAlign:"left",background:manual?"#12678b":"#263d43"}}>Új, terv nélküli előfordulás</button>}
  </div>
  {manual&&<label style={{display:"flex",gap:8,alignItems:"center",marginTop:12}}><input type="checkbox" checked={reproduction} onChange={e=>setReproduction(e.target.checked)}/>Kifejezett újragyártás</label>}
  {source&&<p style={{fontSize:13,color:"#cbd5e1"}}>Kiválasztott sor: {source.source_id} · Teljesített: {completed} db{remaining!==null?` · Hátralévő: ${remaining} db`:""}</p>}
  {action==="END"&&source&&<div style={{display:"grid",gap:8,marginTop:12}}><label>Most elkészült darabszám *<input type="number" min="1" step="1" required value={quantity} onChange={e=>setQuantity(e.target.value)} style={{...recurringDialogInput,marginTop:5}}/></label><label>Megjegyzés<textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} style={{...recurringDialogInput,marginTop:5}}/></label><small>Az END lezárja a mostani munkaszakaszt. Ha a teljesített mennyiség kisebb a tervnél, a sor folyamatban marad és később folytatható.</small></div>}
  {error&&<p role="alert" style={{color:"#fca5a5"}}>{error}</p>}
  <div style={{display:"flex",gap:9,flexWrap:"wrap",marginTop:16}}><button type="button" style={recurringDialogButton} disabled={busy||(!manual&&!source)} onClick={()=>void run()}>{busy?"Mentés...":action==="START"?"START mentése":"END mentése"}</button><button type="button" style={recurringDialogButton} disabled={busy} onClick={onClose}>Mégse</button></div>
 </div></div>;
}
