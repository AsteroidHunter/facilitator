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
const SHOTS = process.env.PWA_COLOR_SHOTS || "";
const FONT_CACHE = process.env.PWA_COLOR_FONT_CACHE || "";
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
  fixture=await mkdtemp(path.join(tmpdir(),"m688-colors-")); const port=await freePort();
  const source=(await readFile(path.join(ROOT,"server.py"),"utf8")).replace("PORT = 8877","PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  await writeFile(path.join(fixture,"server.py"),source);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixture,"server.py")));
  for(const name of ["m.html","m-sw.js","m-manifest.json","card-markdown.js","card-tokens.css","card-logic.js","card-report.js","compose-format.js","cm-markdown.js"])
    await copyFile(path.join(ROOT,name),path.join(fixture,name));
  await mkdir(path.join(fixture,"assets"));
  for(const name of await readdir(path.join(ROOT,"assets"))) await copyFile(path.join(ROOT,"assets",name),path.join(fixture,"assets",name));
  await writeFile(path.join(fixture,"seed.json"),JSON.stringify({title:"swipe fixture",items:[{id:"0",bucket:"meta",title:"Base",owner:"facilitator",context:""}]}));
  await writeFile(path.join(fixture,"run.config.json"),JSON.stringify({lanes:[
    {owner:"facilitator",dir:path.join(fixture,"garden")},
    {owner:"pastureland",dir:path.join(fixture,"workshop")}
  ]}));
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
  // a phone's top safe area; the foot is the row of buttons' band whatever the safe area
  await page.addStyleTag({content:"#page{padding-top:calc(44px + var(--app-inset))}"});
  await page.waitForFunction(()=>!document.getElementById("loading"),{timeout:15000});
  await pause(300); // Let the fixture safe-area padding finish its keyboard-clock transition.
  if(SHOTS){await mkdir(SHOTS,{recursive:true});await writeFile(path.join(SHOTS,"font-evidence.json"),JSON.stringify({viewport:PHONE,loadedFonts,cachedFonts:!!FONT_CACHE},null,2));}
});
after(async()=>{if(browser)await browser.close();if(child&&child.exitCode===null){child.kill("SIGTERM");await once(child,"exit")}if(fixture)await rm(fixture,{recursive:true,force:true})});

async function capture(name, side="left"){
  const state=await page.evaluate(side=>{
    // the page's paper shows above the card, under the status bar, read clear of
    // the card's shadow; the gap between the card's foot and the row of buttons
    // is the same paper but carries both their shadows
    const sheet=document.getElementById("page"), pane=document.getElementById("pane");
    const ps=getComputedStyle(sheet), bs=getComputedStyle(document.body),
      sr=sheet.getBoundingClientRect();
    const scrim=getComputedStyle(document.getElementById("scrim"));
    return {pageFill:ps.backgroundColor,pageImage:ps.backgroundImage,bodyFill:bs.backgroundColor,
      cardFill:getComputedStyle(pane).backgroundColor,
      listFill:getComputedStyle(document.getElementById("tickets")).backgroundColor,
      drawerItems:[...document.querySelectorAll(".trow")].map(el=>({id:el.dataset.id,classes:el.className,fill:getComputedStyle(el).backgroundColor})),
      scrimFill:scrim.backgroundColor,scrimOpacity:Number(scrim.opacity),pageTop:sr.top,pageScale:new DOMMatrix(ps.transform).a,
      drawerOpen:drawerOpen(),settingsOpen:settings.classList.contains("open"),
      paneReplyLength:document.querySelector(".box.sel .reply").textContent.length,
      transitions:document.getAnimations().filter(a=>["page","pane","tickets","settings","scrim"].includes(a.effect?.target?.id)).length,
      points:{canvas:{x:innerWidth/2,y:6},
        abovePage:{x:side==="right"?18:innerWidth-18,y:0.2},
        insidePage:{x:side==="right"?18:innerWidth-18,y:20}}};
  },side);
  const bytes=await page.screenshot({path:SHOTS?path.join(SHOTS,name+".png"):undefined});
  state.pixels=await page.evaluate(async({png,points})=>{
    const picture=new Image();picture.src="data:image/png;base64,"+png;await picture.decode();
    const canvas=document.createElement("canvas");canvas.width=picture.naturalWidth;canvas.height=picture.naturalHeight;
    const ctx=canvas.getContext("2d");ctx.drawImage(picture,0,0);
    return Object.fromEntries(Object.entries(points).map(([name,p])=>[name,
      [...ctx.getImageData(Math.floor(p.x*devicePixelRatio),Math.floor(p.y*devicePixelRatio),1,1).data].slice(0,3)]));
  },{png:Buffer.from(bytes).toString("base64"),points:state.points});
  return {name,...state};
}
function unified(state){
  assert.equal(state.pageFill,"rgb(255, 255, 255)");
  assert.equal(state.bodyFill,state.pageFill);
  assert.equal(state.pageImage,"none","a page-only highlight creates the recession seam");
  assert.equal(state.cardFill,"rgb(255, 255, 255)","card's intentional white changed");
  assert.equal(state.listFill,"rgba(0, 0, 0, 0)","the card list paints a panel of its own over the paper");
  assert.equal(state.scrimFill,"rgba(33, 29, 23, 0.18)","drawer dimming changed");
  const seam=state.pixels.abovePage.map((v,i)=>Math.abs(v-state.pixels.insidePage[i]));
  assert.ok(Math.max(...seam)<=1,`top seam in ${state.name}: ${JSON.stringify(state.pixels)}`);
  if(state.name.endsWith("normal")||state.name.endsWith("closed")){
    for(const key of ["canvas"]){
      const pixel=state.pixels[key];assert.ok(pixel.every(v=>Math.abs(v-255)<=1),`${state.name} ${key} differs: ${pixel}`);
    }
  }
}

test("workspace paper remains connected across tabs, the card list's frames and the settings' receding frames",async()=>{
  const dense=await page.evaluate(()=>navigationPool(lastState).find(b=>els[b.id]?.reply.textContent.length>400).id);
  const sparse=await create("A quiet garden card");
  await page.waitForFunction(id=>!!els[id],{},sparse);
  const evidence=[];
  for(const [kind,id] of [["populated",dense],["sparse",sparse]]){
    await page.evaluate(id=>select(id),id);await pause(360);
    evidence.push(await capture(kind+"-normal"));
    await page.evaluate(()=>openDrawer());await pause(160);
    evidence.push(await capture(kind+"-drawer-opening"));
    await pause(600);evidence.push(await capture(kind+"-drawer-open"));
    await page.evaluate(()=>closeDrawer());await pause(160);
    evidence.push(await capture(kind+"-drawer-closing"));
    await pause(600);evidence.push(await capture(kind+"-closed"));
  }
  await page.evaluate(()=>showMenu(settings));await pause(160);
  evidence.push(await capture("settings-opening","right"));await pause(600);
  evidence.push(await capture("settings-open","right"));
  await page.evaluate(()=>hideMenu(settings));await pause(650);
  if(SHOTS)await writeFile(path.join(SHOTS,"color-evidence.json"),JSON.stringify(evidence,null,2));
  for(const state of evidence)unified(state);
  assert.ok(evidence.find(s=>s.name==="populated-normal").paneReplyLength>400);
  assert.equal(evidence.find(s=>s.name==="sparse-normal").paneReplyLength,0);
  const inRun=s=>s.name.endsWith("opening")||s.name.endsWith("closing");
  // the card list draws the page back not at all and the shade not at all: the card goes down and the box comes in
  assert.ok(evidence.filter(s=>inRun(s)&&s.name.includes("drawer")).every(s=>s.transitions>0&&s.pageScale===1&&s.scrimOpacity===0),"did not inspect actual card list animation frames");
  assert.ok(evidence.filter(s=>s.name.endsWith("-drawer-open")).every(s=>s.pageScale===1&&s.scrimOpacity===0&&s.drawerOpen));
  // the settings draw it back
  assert.ok(evidence.filter(s=>inRun(s)&&s.name.startsWith("settings")).every(s=>s.transitions>0&&s.pageScale<1&&s.pageScale>.985),"did not inspect actual settings animation frames");
  assert.ok(evidence.filter(s=>s.name==="settings-open").every(s=>s.pageScale===.985&&s.scrimOpacity===1));
  assert.ok(evidence.filter(s=>s.name.endsWith("-closed")).every(s=>s.pageScale===1&&s.scrimOpacity===0));
});
