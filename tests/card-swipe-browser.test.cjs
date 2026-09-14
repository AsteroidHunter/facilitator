const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT,".venv/bin/python3");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width:375, height:812, deviceScaleFactor:3, isMobile:true, hasTouch:true };
const SHOTS = process.env.CARD_SWIPE_SHOTS || "";
const FONT_CACHE = process.env.CARD_SWIPE_FONT_CACHE || "";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, child, fixture, origin, page, cdp;

async function freePort(){
  const server=createServer(); await new Promise((ok,no)=>{server.once("error",no);server.listen(0,"127.0.0.1",ok)});
  const port=server.address().port; await new Promise(ok=>server.close(ok)); return port;
}
async function api(route, body){ return fetch(origin+route,{method:"POST",body}); }
async function create(title){ return (await (await api("/create?owner=facilitator",title)).json()).id; }
async function touch(type,x,y){
  await cdp.send("Input.dispatchTouchEvent", {type, touchPoints:type === "touchEnd" || type === "touchCancel" ? [] : [{x,y}]});
}
async function drag(from,to,{cancel=false,hold=false}={}){
  await touch("touchStart",from.x,from.y); await touch("touchMove",to.x,to.y);
  if (hold) return;
  await touch(cancel?"touchCancel":"touchEnd",to.x,to.y); await new Promise(r=>setTimeout(r,330));
}
async function selected(){ return page.evaluate(()=>selectedId); }

before(async()=>{
  fixture=await mkdtemp(path.join(tmpdir(),"m687-swipe-")); const port=await freePort();
  const source=(await readFile(path.join(ROOT,"server.py"),"utf8")).replace("PORT = 8877","PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  await writeFile(path.join(fixture,"server.py"),source);
  for(const name of ["m.html","m-sw.js","m-manifest.json","card-markdown.js","card-tokens.css","card-logic.js","card-report.js","compose-format.js","cm-markdown.js"])
    await copyFile(path.join(ROOT,name),path.join(fixture,name));
  await mkdir(path.join(fixture,"assets"));
  for(const name of await readdir(path.join(ROOT,"assets"))) await copyFile(path.join(ROOT,"assets",name),path.join(fixture,"assets",name));
  await writeFile(path.join(fixture,"seed.json"),JSON.stringify({title:"swipe fixture",items:[{id:"0",bucket:"meta",title:"Base",owner:"facilitator",context:""}]}));
  origin=`http://127.0.0.1:${port}`;
  child=spawn(PYTHON,[path.join(fixture,"server.py")],{cwd:fixture,env:{...process.env,FACILITATOR_TEST_PORT:String(port)},stdio:"ignore"});
  for(let i=0;i<200;i++){try{if((await fetch(origin+"/state")).ok)break}catch{} await new Promise(r=>setTimeout(r,25));}
  const made=["0"]; for(const title of ["Garden paths after the rain","A place for the small tools","Keeping the seedlings warm"]) made.push(await create(title));
  for (const [index,id] of made.entries()) {
    const message = "Please keep the garden notes together. The eastern path needs room for the wheelbarrow, and the seedlings should stay close to the warm wall.\n\nShow the practical details clearly so the next person can pick up the work.";
    assert.equal((await api(`/send?box=${id}`, message)).status,200);
    const claim = await (await fetch(origin+"/wait?owner=facilitator&timeout=0&agent=swipe-fixture")).json();
    assert.equal(claim.box,id);
    assert.equal((await api(`/ack?owner=facilitator&token=${encodeURIComponent(claim.ack)}`,"")).status,200);
    const reply = `**The garden plan is ready.** The ${["north","east","south","west"][index]} bed has enough room for the new plants.\n\n` +
      "A narrow gravel path separates the beds. Keep its edges visible so visitors can see where each planting area begins and ends.\n\n" +
      "The tools belong on the low shelf beside the gate. Put the watering can near the tap and leave the hand fork within reach.\n\n" +
      "The next visit covers three small jobs:\n\n- Check the new shoots.\n- Water the sheltered pots.\n- Clear the path before sunset.\n\n" +
      "These notes are invented test content. They fill the card with realistic headings, paragraphs and an answered message box.";
    assert.equal((await api(`/reply?box=${id}&ctx=Invented+garden+fixture`,reply)).status,200);
  }
  browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:["--disable-background-networking","--no-first-run"]});
  page=await browser.newPage(); await page.setViewport(PHONE);
  if (FONT_CACHE) {
    const manifest = JSON.parse(await readFile(path.join(FONT_CACHE,"manifest.json"),"utf8"));
    const responses = new Map();
    for (const sheet of manifest.stylesheets) responses.set(sheet.source_url,{contentType:"text/css",body:await readFile(path.join(FONT_CACHE,sheet.original))});
    for (const [url,file] of Object.entries(manifest.font_assets)) responses.set(url,{contentType:"font/woff2",body:await readFile(path.join(FONT_CACHE,file))});
    await page.setRequestInterception(true);
    page.on("request",request=>{
      const cached=responses.get(request.url());
      if(cached) return request.respond({status:200,headers:{"Access-Control-Allow-Origin":"*"},...cached});
      if(request.url().startsWith(origin+"/")||request.url().startsWith("data:")) return request.continue();
      return request.abort();
    });
  }
  await page.goto(origin+"/m",{waitUntil:"domcontentloaded"});
  await page.evaluate(async()=>{
    await Promise.all([document.fonts.load('400 17px "IBM Plex Sans"'),document.fonts.load('625 24px "Inter"'),document.fonts.load('400 12px "IBM Plex Mono"')]);
    await document.fonts.ready;
  });
  const loadedFonts=await page.evaluate(()=>[...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family.replace(/["']/g,"")));
  if(FONT_CACHE) assert.ok(loadedFonts.includes("Inter")&&loadedFonts.includes("IBM Plex Sans"),"cached product fonts did not load: "+JSON.stringify(loadedFonts));
  await page.waitForFunction(()=>lastState!==null); cdp=await page.createCDPSession();
  await page.addStyleTag({content:"#page{padding-top:calc(44px + var(--app-inset));--pad-b:calc(34px + var(--app-inset))}"});
  await page.waitForFunction(()=>!document.getElementById("loading"),{timeout:15000});
  await pause(300); // Let the fixture safe-area padding finish its keyboard-clock transition.
  if(SHOTS){await mkdir(SHOTS,{recursive:true});await writeFile(path.join(SHOTS,"font-evidence.json"),JSON.stringify({viewport:PHONE,loadedFonts,cachedFonts:!!FONT_CACHE},null,2));}
});
after(async()=>{if(browser)await browser.close();if(child&&child.exitCode===null){child.kill("SIGTERM");await once(child,"exit")}if(fixture)await rm(fixture,{recursive:true,force:true})});

test("swipes use keyboard order and keep a face-on vertical center",async()=>{
  const order=await page.evaluate(()=>navigationPool(lastState).map(b=>b.id)); assert.ok(order.length>=4);
  await page.evaluate(id=>select(id),order[1]);
  const rect=await page.$eval("article.box.sel",el=>{const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:el.querySelector(".head").getBoundingClientRect().top+12,centerY:r.top+r.height/2,w:r.width,h:r.height}});
  await drag({x:rect.x,y:rect.y},{x:rect.x-130,y:rect.y},{hold:true});
  const mid=await page.evaluate(()=>[...document.querySelectorAll(".box.cardswipe")].map(el=>{const r=el.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(el).transform);return{id:el.id,x:m.m41,y:m.m42,scale:m.a,midY:(r.top+r.bottom)/2}}));
  assert.equal(mid.length,2); assert.ok(mid.some(v=>v.x<0)); assert.ok(mid.every(v=>Math.abs(v.y)<.01));
  assert.ok(mid.every(v=>v.scale<1&&v.scale>.96)); assert.ok(mid.every(v=>Math.abs(v.midY-rect.centerY)<.05));
  if(SHOTS)await page.screenshot({path:path.join(SHOTS,"swipe-next-mid.png")}); await touch("touchEnd",rect.x-130,rect.y); await new Promise(r=>setTimeout(r,330));
  assert.equal(await selected(),order[2]);
  await drag({x:rect.x,y:rect.y},{x:rect.x+130,y:rect.y},{hold:true});
  if(SHOTS)await page.screenshot({path:path.join(SHOTS,"swipe-previous-mid.png")}); await touch("touchEnd",rect.x+130,rect.y); await new Promise(r=>setTimeout(r,330));
  assert.equal(await selected(),order[1]);
  await page.keyboard.down("Control");await page.keyboard.down("Shift");await page.keyboard.press("ArrowLeft");await page.keyboard.up("Shift");await page.keyboard.up("Control");
  assert.equal(await selected(),order[0]);
  await drag({x:rect.x,y:rect.y},{x:rect.x+130,y:rect.y}); assert.equal(await selected(),order.at(-1),"previous boundary must wrap like the keyboard");
  await page.evaluate(id=>select(id),order.at(-1)); await drag({x:rect.x,y:rect.y},{x:rect.x-130,y:rect.y}); assert.equal(await selected(),order[0],"next boundary must wrap like the keyboard");
});

test("gesture arbitration preserves scrolling, editors, edges and cancellation",async()=>{
  const start=await selected(); const r=await page.$eval("article.box.sel",el=>{const x=el.getBoundingClientRect();return{x:x.left+x.width/2,y:el.querySelector(".head").getBoundingClientRect().top+12}});
  await drag({x:r.x,y:r.y},{x:r.x+8,y:r.y+120}); assert.equal(await selected(),start,"vertical gesture navigated");
  const edit=await page.$eval("article.box.sel textarea",el=>{const x=el.getBoundingClientRect();return{x:x.left+x.width/2,y:x.top+x.height/2}});
  await drag(edit,{x:edit.x-140,y:edit.y}); assert.equal(await selected(),start,"editor selection gesture navigated");
  await drag({x:8,y:r.y},{x:150,y:r.y}); assert.equal(await selected(),start,"edge drawer gesture navigated cards");
  await page.evaluate(()=>{const p=menuOut();if(p)hideMenu(p)});
  await drag({x:r.x,y:r.y},{x:r.x-140,y:r.y},{cancel:true}); assert.equal(await selected(),start,"canceled gesture navigated");
  await drag({x:r.x,y:r.y},{x:r.x-100,y:r.y},{hold:true}); await touch("touchCancel",r.x-100,r.y); await new Promise(r=>setTimeout(r,20));
  await drag({x:r.x,y:r.y},{x:r.x+140,y:r.y}); assert.notEqual(await selected(),start,"gesture after interruption did not run");
});

test("reduced motion changes selection without transformed travel",async()=>{
  await page.emulateMediaFeatures([{name:"prefers-reduced-motion",value:"reduce"}]); const start=await selected();
  const r=await page.$eval("article.box.sel",el=>{const x=el.getBoundingClientRect();return{x:x.left+x.width/2,y:el.querySelector(".head").getBoundingClientRect().top+12}});
  await drag({x:r.x,y:r.y},{x:r.x-140,y:r.y},{hold:true});
  const transforms=await page.$$eval(".box.cardswipe",els=>els.map(el=>new DOMMatrix(getComputedStyle(el).transform)).map(m=>({x:m.m41,y:m.m42,s:m.a})));
  assert.ok(transforms.every(m=>m.x===0&&m.y===0&&m.s===1)); await touch("touchEnd",r.x-140,r.y); await new Promise(r=>setTimeout(r,30));
  assert.notEqual(await selected(),start); await page.emulateMediaFeatures([]);
});

async function surfaces(){
  return page.evaluate(()=>{
    const pane=document.getElementById("pane"), ps=getComputedStyle(pane), pr=pane.getBoundingClientRect();
    const faces=[...document.querySelectorAll(".box.cardswipe")].map(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el),matrix=new DOMMatrix(s.transform);
      return {id:el.id,left:r.left,right:r.right,centerY:(r.top+r.bottom)/2,y:matrix.m42,
        fill:s.backgroundColor,border:s.borderLeftWidth,borderColor:s.borderLeftColor,radius:s.borderRadius,
        shadow:s.boxShadow,overflow:s.overflow,replyLength:el.querySelector(".reply").textContent.length};
    }).sort((a,b)=>a.left-b.left);
    return {paneFill:ps.backgroundColor,paneBorder:ps.borderTopColor,paneShadow:ps.boxShadow,
      centerY:(pr.top+pr.bottom)/2,faces,gap:faces.length===2?faces[1].left-faces[0].right:null,
      transitions:document.getAnimations().filter(a=>a.effect?.target?.matches?.(".box.cardswipe")).length};
  });
}
function distinct(frame){
  assert.equal(frame.faces.length,2);
  assert.equal(frame.paneFill,"rgba(0, 0, 0, 0)","shared white wrapper connects the cards");
  assert.equal(frame.paneBorder,"rgba(0, 0, 0, 0)","shared outer border remains across the cards");
  assert.equal(frame.paneShadow,"none");
  assert.ok(frame.gap>=12,`card surfaces have no clear gap: ${frame.gap}`);
  for(const face of frame.faces){
    assert.equal(face.fill,"rgb(255, 255, 255)"); assert.equal(face.border,"1px");
    assert.notEqual(face.borderColor,"rgba(0, 0, 0, 0)"); assert.equal(face.radius,"7px");
    assert.notEqual(face.shadow,"none"); assert.equal(face.overflow,"hidden");
    assert.ok(face.replyLength>400,"empty fixture cannot prove the moving card surface");
    assert.ok(Math.abs(face.y)<.01); assert.ok(Math.abs(face.centerY-frame.centerY)<.05);
  }
}

test("populated cards retain separate surfaces during drag and settling in both directions",async()=>{
  const order=await page.evaluate(()=>navigationPool(lastState).map(b=>b.id)); const evidence=[];
  for(const [name,from,to,direction] of [["next",order[1],order[2],-1],["previous",order[2],order[1],1]]){
    await page.evaluate(id=>select(id),from); await pause(360);
    const point=await page.$eval("article.box.sel .head",el=>{const r=el.getBoundingClientRect();return{x:innerWidth/2,y:r.top+12}});
    await drag(point,{x:point.x+direction*130,y:point.y},{hold:true});
    const held=await surfaces(); evidence.push({name,phase:"drag",...held});
    if(SHOTS)await page.screenshot({path:path.join(SHOTS,`${name}-populated-drag.png`)});
    await touch("touchEnd",point.x+direction*130,point.y); await pause(40);
    const settling=await surfaces(); evidence.push({name,phase:"settle",...settling});
    if(SHOTS)await page.screenshot({path:path.join(SHOTS,`${name}-populated-settle.png`)});
    await pause(330); assert.equal(await selected(),to);
    if(SHOTS)await page.screenshot({path:path.join(SHOTS,`${name}-populated-final.png`)});
  }
  if(SHOTS)await writeFile(path.join(SHOTS,"surface-evidence.json"),JSON.stringify(evidence,null,2));
  for(const frame of evidence) distinct(frame);
  assert.ok(evidence.filter(f=>f.phase==="settle").every(f=>f.transitions===2),"settle sample missed the actual transition");
});
