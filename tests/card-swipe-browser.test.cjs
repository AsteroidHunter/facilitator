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
const PHONE = { width:390, height:844, deviceScaleFactor:3, isMobile:true, hasTouch:true };
const SHOTS = process.env.CARD_SWIPE_SHOTS || "";
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
  const made=[]; for(const title of ["First","Second","Third"]) made.push(await create(title));
  browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:["--disable-background-networking","--no-first-run"]});
  page=await browser.newPage(); await page.setViewport(PHONE); await page.goto(origin+"/m",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>lastState!==null); cdp=await page.createCDPSession(); if(SHOTS)await mkdir(SHOTS,{recursive:true});
});
after(async()=>{if(browser)await browser.close();if(child&&child.exitCode===null){child.kill("SIGTERM");await once(child,"exit")}if(fixture)await rm(fixture,{recursive:true,force:true})});

test("swipes use keyboard order and keep a face-on vertical center",async()=>{
  const order=await page.evaluate(()=>navigationPool(lastState).map(b=>b.id)); assert.ok(order.length>=4);
  await page.evaluate(id=>select(id),order[1]);
  const rect=await page.$eval("article.box.sel",el=>{const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}});
  await drag({x:rect.x,y:rect.y},{x:rect.x-130,y:rect.y},{hold:true});
  const mid=await page.evaluate(()=>[...document.querySelectorAll(".box.cardswipe")].map(el=>{const r=el.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(el).transform);return{id:el.id,x:m.m41,y:m.m42,scale:m.a,midY:(r.top+r.bottom)/2}}));
  assert.equal(mid.length,2); assert.ok(mid.some(v=>v.x<0)); assert.ok(mid.every(v=>Math.abs(v.y)<.01));
  assert.ok(mid.every(v=>v.scale<1&&v.scale>.96)); assert.ok(mid.every(v=>Math.abs(v.midY-rect.y)<.05));
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
  const start=await selected(); const r=await page.$eval("article.box.sel",el=>{const x=el.getBoundingClientRect();return{x:x.left+x.width/2,y:x.top+x.height/2}});
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
  const r=await page.$eval("article.box.sel",el=>{const x=el.getBoundingClientRect();return{x:x.left+x.width/2,y:x.top+x.height/2}});
  await drag({x:r.x,y:r.y},{x:r.x-140,y:r.y},{hold:true});
  const transforms=await page.$$eval(".box.cardswipe",els=>els.map(el=>new DOMMatrix(getComputedStyle(el).transform)).map(m=>({x:m.m41,y:m.m42,s:m.a})));
  assert.ok(transforms.every(m=>m.x===0&&m.y===0&&m.s===1)); await touch("touchEnd",r.x-140,r.y); await new Promise(r=>setTimeout(r,30));
  assert.notEqual(await selected(),start); await page.emulateMediaFeatures([]);
});
